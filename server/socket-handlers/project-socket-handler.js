const { R } = require("redbean-node");
const { Settings } = require("../settings");
const { loginRateLimiter } = require("../rate-limiter");
const { permit, id, problem } = require("../projects/access");
const store = require("../projects/store");
const ai = require("../projects/ai-service");
const subscription = require("../projects/subscription");
const delivery = require("../notification-delivery");
const { getVault } = require("../projects/vault");
const { doubleCheckPassword } = require("../util-server");
const busy = new Set();
const recovery = require("../projects/recovery");
const siteRecovery = require("../projects/site-recovery");
const codeRecovery = require("../projects/code-recovery");

/**
 * Closed project API. Human identity never becomes the internal data-owner identity.
 * @param {Socket} socket Authenticated connection
 * @param {object} services Existing monitor lifecycle and configured origin
 * @returns {void}
 */
function projectSocketHandler(socket, services) {
    const channelGuard =
        (userID, request, guard, role = "admin") =>
        async (db = R.knex) => {
            await guard(db);
            return permit(userID, id(request.projectID), role, db);
        };
    const channelAction = async (userID, request, guard, action) => {
        const scope = await permit(userID, id(request.projectID), "admin");
        return action(scope, channelGuard(userID, request, guard));
    };
    const actions = {
        projectWitnessStatus: (userID) => require("../independent-witness").status(userID),
        projectTrackingGet: (userID, request) => require("../projects/tracking").overview(userID, request),
        projectTrackingSave: async (userID, request, guard) => {
            await require("../projects/tracking").save(userID, request, guard);
            return {};
        },
        projectList: async (userID) => ({ projects: await store.listProjects(userID) }),
        projectCreate: async (userID, request, guard) => ({ id: await store.createProject(userID, request, guard) }),
        projectSnapshot: (userID, request) => store.projectSnapshot(userID, id(request.projectID)),
        projectUpdate: async (userID, request, guard) => {
            await store.updateProject(userID, request, guard);
            return {};
        },
        projectMembers: (userID, request) => store.members(userID, id(request.projectID)),
        projectChangeMember: async (userID, request, guard) => {
            await store.changeMember(userID, request, guard);
            ai.cancelActive(request.projectID);
            return {};
        },
        projectCreateInvite: (userID, request, guard) => store.invite(userID, request, guard),
        projectRevokeInvite: async (userID, request, guard) => {
            await store.revokeInvite(userID, request, guard);
            return {};
        },
        projectInviteInfo: async (_userID, request) => store.inviteInfo(request.token),
        projectAcceptInvite: (userID, request, guard) => store.acceptInvite(userID, request, guard),
        projectSaveMonitor: async (userID, request, guard) => {
            const monitorID = await store.saveMonitor(userID, request, guard);
            const scope = await permit(userID, request.projectID, "operator");
            await guard();
            await services.restartMonitor(scope.data_user_id, monitorID);
            return { id: monitorID };
        },
        projectMonitorEditor: (userID, request) => store.monitorEditor(userID, request),
        projectMonitorVerification: async (userID, request, guard) => {
            const projectID = id(request.projectID);
            const scope = await permit(userID, projectID);
            const result = await require("../monitor-verification").readVerification(
                scope.data_user_id,
                request.id,
                request.includeImage === true
            );
            const current = await permit(userID, projectID);
            if (current.revision !== scope.revision || current.data_user_id !== scope.data_user_id) {
                throw problem("projectChanged");
            }
            await guard();
            return result;
        },
        projectControlMonitor: async (userID, request, guard) => {
            const changed = await store.controlMonitor(userID, request, guard);
            await permit(userID, request.projectID, "operator");
            await guard();
            await services.syncMonitor(changed.ownerID, changed.id);
            return {};
        },
        projectDeliveryGet: async (userID, request) => {
            const scope = await permit(userID, id(request.projectID));
            const result = await delivery.deliveryOverview(scope.data_user_id, request.monitorID ?? null);
            if (scope.role !== "admin") {
                result.channels = result.channels.map(({ id: channelID, name, type, managed, monitorIDs }) => ({
                    id: channelID,
                    name,
                    type,
                    managed,
                    monitorIDs,
                }));
            }
            await permit(userID, request.projectID, scope.role);
            return result;
        },
        projectAlertRules: async (userID, request) => {
            const scope = await permit(userID, id(request.projectID), "admin");
            const rules = await require("../notification-escalation").rulesForOwner(scope.data_user_id);
            const current = await permit(userID, scope.id, "admin");
            if (current.revision !== scope.revision) {
                throw problem("projectChanged");
            }
            return { rules };
        },
        projectSaveAlertRule: (userID, request, guard) =>
            channelAction(userID, request, guard, async (scope, authorized) => {
                await require("../notification-escalation").saveRule(scope.data_user_id, request, authorized, scope.id);
                return {};
            }),
        projectDeliverySave: (userID, request, guard) =>
            channelAction(userID, request, guard, async (scope, authorized) => ({
                id: await delivery.saveManagedChannel(scope.data_user_id, request, authorized, scope.id),
            })),
        projectDeliveryTest: (userID, request, guard) =>
            channelAction(userID, request, guard, async (scope, authorized) => ({
                id: await delivery.requestTest(scope.data_user_id, request, authorized, {
                    projectID: scope.id,
                    userID,
                }),
            })),
        projectDeliveryConfirm: (userID, request, guard) =>
            channelAction(userID, request, guard, async (scope, authorized) => {
                await delivery.confirmReceipt(scope.data_user_id, request.id, authorized);
                return {};
            }),
        projectDeliveryDelete: (userID, request, guard) =>
            channelAction(userID, request, guard, async (scope, authorized) => {
                await delivery.deleteManagedChannel(scope.data_user_id, request, authorized);
                return {};
            }),
        projectAISettings: async (userID, request) => {
            const projectID = id(request.projectID);
            const settings = await ai.settings(userID, projectID);
            const worker = await require("../ai-worker/transport").status();
            await permit(userID, projectID, "admin");
            return { settings, worker, localSignIn: services.localSignIn };
        },
        projectAISave: (userID, request, guard) => ai.saveSettings(userID, request, guard),
        projectAIModels: async (userID, request, guard) => ({ models: await ai.models(userID, request, guard) }),
        projectAIPrepare: (userID, request) => ai.prepare(userID, request),
        projectAIEnqueue: async (userID, request, guard) => ({ id: await ai.enqueue(userID, request, guard) }),
        projectAIJobs: async (userID, request) => ({ jobs: await ai.jobs(userID, id(request.projectID)) }),
        projectAIAutomationGet: async (userID, request) => ({
            settings: await require("../projects/ai-automation").settings(userID, id(request.projectID)),
        }),
        projectAIAutomationSave: async (userID, request, guard) => ({
            settings: await require("../projects/ai-automation").save(userID, request, guard),
        }),
        projectRecoveryGet: async (userID, request) => ({
            ...(await recovery.overview(userID, id(request.projectID))),
            site: await siteRecovery.overview(userID, id(request.projectID)),
        }),
        projectSiteRecoveryGet: (userID, request) => siteRecovery.overview(userID, id(request.projectID)),
        projectCodeRecoveryGet: (userID, request) => codeRecovery.overview(userID, id(request.projectID)),
        projectCodeRecoveryIndex: codeRecovery.index,
        projectCodeRecoveryPreview: codeRecovery.preview,
        projectCodeRecoveryGenerate: codeRecovery.generate,
        projectCodeRecoveryDetails: codeRecovery.details,
        projectCodeRecoveryApprove: codeRecovery.approve,
        projectCodeRecoveryCancel: codeRecovery.cancel,
        projectCodeRecoveryRollback: codeRecovery.rollback,
        projectCodeRecoveryReset: codeRecovery.reset,
        projectCodeRecoveryExport: codeRecovery.exportPatch,
        projectSiteRecoveryPlan: async (userID, request, guard) => ({
            job: await siteRecovery.createPlan(userID, request, guard),
        }),
        projectSiteRecoveryApprove: async (userID, request, guard) => ({
            job: await siteRecovery.approve(userID, request, guard),
        }),
        projectSiteRecoveryCancel: async (userID, request, guard) => {
            await siteRecovery.cancel(userID, request, guard);
            return {};
        },
        projectSiteRecoveryRollback: async (userID, request, guard) => {
            await siteRecovery.rollback(userID, request, guard);
            return {};
        },
        projectSiteRecoveryReset: async (userID, request, guard) => {
            await siteRecovery.reset(userID, request, guard);
            return {};
        },
        projectRecoveryPlan: async (userID, request, guard) => ({
            job: await recovery.createPlan(userID, request, guard),
        }),
        projectRecoveryApprove: async (userID, request, guard) => ({
            job: await recovery.approve(userID, request, guard),
        }),
        projectRecoveryCancel: async (userID, request, guard) => {
            await recovery.cancel(userID, request, guard);
            return {};
        },
        projectRecoveryRollback: async (userID, request, guard) => {
            await recovery.rollback(userID, request, guard);
            return {};
        },
        projectRecoveryReset: async (userID, request, guard) => {
            await recovery.reset(userID, request, guard);
            return {};
        },
        projectAICancel: async (userID, request, guard) => {
            await ai.cancelJob(userID, request, guard);
            return {};
        },
        projectAISignIn: async (userID, request, guard) => {
            if (!services.localSignIn) {
                throw problem("projectSignInNeedsHelper");
            }
            return subscription.beginLocal(userID, request, guard, await services.baseURL(), services.callbackOrigin);
        },
        projectAIPairing: async (userID, request, guard) => ({
            pairing: await subscription.begin(userID, request, guard, await services.baseURL()),
        }),
        projectAudit: async (userID, request) => {
            await permit(userID, id(request.projectID), "admin");
            const events = await R.knex("project_audit as a")
                .leftJoin("user as u", "u.id", "a.user_id")
                .where("a.project_id", request.projectID)
                .orderBy("a.id", "desc")
                .limit(100)
                .select("a.id", "a.action", "a.target", "a.created_at", "u.username");
            await permit(userID, request.projectID, "admin");
            return { events };
        },
        projectPeriodSummary: async (userID, request) => {
            const scope = await permit(userID, id(request.projectID));
            const range = require("../heartbeat-export").validateExportRequest(request);
            if (Date.parse(request.end) > Date.now()) {
                throw problem("projectInvalid");
            }
            const monitor = await R.knex("monitor").where({ id: range.monitorID, user_id: scope.data_user_id }).first();
            if (!monitor || monitor.type === "group") {
                throw problem();
            }
            const history = await require("../period-summary-history").loadSummaryHistory(range, Date.now());
            await permit(userID, request.projectID);
            return {
                summary: require("../period-summary").buildPeriodSummary(history.rows, request.start, request.end),
            };
        },
        projectRotateKey: async (userID, request, guard) => {
            const actor = await R.knex("user")
                .where({ id: userID, active: 1, project_only: 0, service_account: 0 })
                .first();
            if (!actor) {
                throw problem();
            }
            await doubleCheckPassword(socket, request.currentPassword);
            await guard();
            await getVault().rotate(R.knex);
            return {};
        },
    };
    for (const [event, action] of Object.entries(actions)) {
        socket.on(event, async (request, callback) => {
            if (typeof callback !== "function") {
                return;
            }
            const actorID = socket.userID || null;
            const generation = socket.projectGeneration;
            let acquired = false;
            const guard = async (db = R.knex) => {
                if (
                    (socket.userID || null) !== actorID ||
                    socket.projectGeneration !== generation ||
                    socket.disconnected === true
                ) {
                    throw problem();
                }
                if (actorID) {
                    const user = await db("user").where({ id: actorID, service_account: 0 }).first();
                    const active =
                        user &&
                        (user.project_only
                            ? await db("project_identity").where({ user_id: actorID, active: 1 }).first()
                            : user.active);
                    if (!active) {
                        throw problem();
                    }
                }
            };
            try {
                if (!request || typeof request !== "object" || Array.isArray(request)) {
                    throw problem("projectInvalid");
                }
                const publicAction = ["projectInviteInfo", "projectAcceptInvite"].includes(event);
                if ((!actorID && !publicAction) || (await Settings.get("disableAuth"))) {
                    throw problem("projectAuthRequired");
                }
                if (publicAction && !(await loginRateLimiter.pass(callback))) {
                    return;
                }
                await guard();
                const key = actorID || socket.id;
                if (busy.has(key)) {
                    throw problem("projectBusy");
                }
                busy.add(key);
                acquired = true;
                const result = await action(actorID, request, guard);
                await guard();
                callback({ ok: true, ...result });
            } catch (error) {
                let code = "projectOperationFailed";
                if (error.msgi18n && /^project[A-Z][a-zA-Z]+$/.test(error.message)) {
                    code = error.message;
                } else if (require("./delivery-socket-handler").isSafeDeliveryError(error.message)) {
                    code = error.message;
                } else if (error instanceof require("../projects/openai-client").AIError) {
                    code = "projectAIError_" + error.code;
                }
                callback({ ok: false, msg: code, msgi18n: true });
            } finally {
                if (acquired) {
                    busy.delete(actorID || socket.id);
                }
            }
        });
    }
}

module.exports = { projectSocketHandler };

const { R } = require("redbean-node");
const { permit, id, problem, audit } = require("./access");
const { projectSnapshot } = require("./store");
const { latencyTrend } = require("../../src/monitor-tracking.ts");

/**
 * @param {object[]} edges Scoped directed edges
 * @returns {boolean} Acyclic dependency graph
 */
function acyclic(edges) {
    const map = new Map();
    for (const edge of edges) {
        if (!map.has(edge.monitor_id)) map.set(edge.monitor_id, []);
        map.get(edge.monitor_id).push(edge.depends_on);
    }
    const visiting = new Set();
    const visited = new Set();
    const visit = (node) => {
        if (visiting.has(node)) return false;
        if (visited.has(node)) return true;
        visiting.add(node);
        for (const next of map.get(node) || []) if (!visit(next)) return false;
        visiting.delete(node);
        visited.add(node);
        return true;
    };
    return [...map.keys()].every(visit);
}
/**
 * @param {number} userID Human
 * @param {object} request Project scope
 * @returns {Promise<object>} Real scoped evidence and advisory dependency links
 */
async function overview(userID, request) {
    const projectID = id(request.projectID);
    const snapshot = await projectSnapshot(userID, projectID);
    const edges = await R.knex("project_dependency")
        .where({ project_id: projectID })
        .select("monitor_id", "depends_on");
    const visible = new Set(snapshot.monitors.map((monitor) => monitor.id));
    await permit(userID, projectID);
    return {
        project: snapshot.project,
        truncated: snapshot.truncated,
        monitors: snapshot.monitors.map((monitor) => ({
            id: monitor.id,
            name: monitor.name,
            type: monitor.type,
            state: monitor.state,
            trend: latencyTrend(monitor, monitor.observations),
            dependencies: edges
                .filter((edge) => edge.monitor_id === monitor.id && visible.has(edge.depends_on))
                .map((edge) => edge.depends_on),
        })),
    };
}
/**
 * @param {number} userID Human
 * @param {object} request Exact owned check IDs and reviewed project revision
 * @param {Function} guard Live authorization
 * @returns {Promise<void>} Acyclic advisory links, never changes or suppresses monitoring results
 */
async function save(userID, request, guard) {
    if (
        !Array.isArray(request.dependencies) ||
        request.dependencies.length > 5 ||
        new Set(request.dependencies).size !== request.dependencies.length
    )
        throw problem("projectInvalid");
    const monitorID = id(request.monitorID);
    const dependencies = request.dependencies.map(id);
    if (dependencies.includes(monitorID)) throw problem("projectDependencyCycle");
    await R.knex.transaction(async (tx) => {
        await guard(tx);
        const scope = await permit(userID, id(request.projectID), "operator", tx);
        if (request.revision !== scope.revision) throw problem("projectChanged");
        const checks = await tx("monitor")
            .where({ user_id: scope.data_user_id })
            .whereIn("id", [monitorID, ...dependencies])
            .whereNot({ type: "group" })
            .select("id");
        if (checks.length !== dependencies.length + 1) throw problem();
        const edges = await tx("project_dependency")
            .where({ project_id: scope.id })
            .whereNot({ monitor_id: monitorID })
            .select("monitor_id", "depends_on");
        if (edges.length + dependencies.length > 1000) throw problem("projectInvalid");
        const added = dependencies.map((dependsOn) => ({
            project_id: scope.id,
            monitor_id: monitorID,
            depends_on: dependsOn,
        }));
        if (!acyclic([...edges, ...added])) throw problem("projectDependencyCycle");
        await tx("project_dependency").where({ project_id: scope.id, monitor_id: monitorID }).delete();
        if (added.length) await tx("project_dependency").insert(added);
        await tx("project").where({ id: scope.id }).increment("revision", 1);
        await audit(tx, scope, "monitorDependenciesChanged", monitorID);
        await guard(tx);
    });
}
module.exports = { overview, save, acyclic };

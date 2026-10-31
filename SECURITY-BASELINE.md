# Deployment status

This fork is a development edition. It has not been approved for production
deployment. The first CSV feature is being validated separately from the
security state of the inherited application.

On 31 October 2026, `npm audit --omit=dev` reported 30 affected packages in the
locked dependency tree: 2 critical, 20 high, 6 moderate and 2 low. These are
registry advisory classifications, not a claim that 30 vulnerabilities have
been reproduced in this application's running paths. Some dependencies are
used by installation or release tools. Reachability and fixes require review.

The critical package classifications include `protobufjs` and `tar`. Do not
expose this edition as a public service until the inherited findings have
been assessed and required dependency changes have been tested. The installed
Node.js runtime must also be included in deployment review.

Relevant primary advisories include:

- [protobufjs code generation](https://github.com/advisories/GHSA-xq3m-2v4x-88gg)
- [node-tar resource consumption](https://github.com/advisories/GHSA-23hp-3jrh-7fpw)

The CSV endpoint checks authentication and monitor ownership, bounds the date
range, row count and output size, limits concurrent exports per account, and
neutralizes formula-like text. Those controls apply to this feature; they do
not establish the security of the entire application.

# XYNE Backend Integration Snapshot

These files are the agent storage, chat route, and chat service surfaces used by
the Polar dump/capture integration. They are copied from the active
`xyne-search/server` checkout so the exact contract can be reviewed and applied
without putting the entire XYNE product repository here.

Apply them to the matching paths in a compatible XYNE checkout and review the
diff. They depend on the surrounding XYNE source tree and are not standalone.
In particular, preserve the optional `agentId` conversation creation path and
the nested run/debug-event dump behavior.

// The ACL engine — one authorization layer for the whole app.
//   - resolveAccess / can / assertCan  (read side, resolver.ts)
//   - grant / revokeBySource / …       (write side, grants.ts)
//   - registerResource                 (extend to new resource types, registry.ts)
// Nothing outside this module should read the `acl` table or reason about roles.

export * from "./types"
export * from "./registry"
export * from "./resolver"
export * from "./grants"

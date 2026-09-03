import { createId } from "@paralleldrive/cuid2"
import { and, eq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { users } from "@/platform/db/schema/users"
import { workspaces } from "@/platform/db/schema/workspaces"
import { UserRole, type UserRole as UserRoleValue } from "@/platform/shared/types"

type KeycloakUserRepresentation = {
  id?: string
  username?: string
  email?: string
  enabled?: boolean
  firstName?: string
  lastName?: string
  attributes?: Record<string, string[] | string>
  [key: string]: unknown
}

type KeycloakUserProfileConfig = {
  attributes?: Array<{
    name: string
    displayName?: string
    permissions?: {
      view?: string[]
      edit?: string[]
    }
    multivalued?: boolean
    [key: string]: unknown
  }>
  [key: string]: unknown
}

type ProvisionConfig = {
  keycloakInternalBaseUrl: string
  keycloakAdmin: string
  keycloakAdminPassword: string
  realm: string
  userEmail: string
  userName: string
  userPassword: string | undefined
  temporaryPassword: boolean
  workspaceExternalId: string
  workspaceClaim: string
  userRole: UserRoleValue
  databaseUrl: string
}

const DEFAULT_KEYCLOAK_WORKSPACE_CLAIM = "xyne_workspace_external_id"

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "")

const buildUrl = (baseUrl: string, path: string) =>
  `${trimTrailingSlash(baseUrl)}${path}`

const requiredEnv = (name: string, fallback?: string): string => {
  const value = process.env[name]?.trim() || fallback
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

const optionalEnv = (name: string): string | undefined => {
  const value = process.env[name]?.trim()
  return value || undefined
}

const booleanEnv = (name: string, defaultValue: boolean) => {
  const value = process.env[name]?.trim()
  if (value === undefined || value === "") {
    return defaultValue
  }
  return value === "true"
}

const parseUserRole = (value: string | undefined): UserRoleValue => {
  const role = value?.trim() || UserRole.User
  const roles = Object.values(UserRole) as string[]
  if (!roles.includes(role)) {
    throw new Error(`Invalid KEYCLOAK_USER_ROLE: ${role}`)
  }
  return role as UserRoleValue
}

const getProvisionConfig = (): ProvisionConfig => {
  const keycloakPort = process.env.KEYCLOAK_PORT?.trim() || "8082"
  const keycloakPublicBaseUrl = requiredEnv(
    "KEYCLOAK_PUBLIC_BASE_URL",
    `http://localhost:${keycloakPort}`,
  )
  const keycloakInternalBaseUrl = requiredEnv(
    "KEYCLOAK_INTERNAL_BASE_URL",
    keycloakPublicBaseUrl,
  )
  const userEmail = requiredEnv("KEYCLOAK_USER_EMAIL").toLowerCase()
  const userName = requiredEnv("KEYCLOAK_USER_NAME", userEmail)
  return {
    keycloakInternalBaseUrl,
    keycloakAdmin: requiredEnv("KEYCLOAK_ADMIN", "admin"),
    keycloakAdminPassword: requiredEnv("KEYCLOAK_ADMIN_PASSWORD", "admin"),
    realm: requiredEnv("KEYCLOAK_REALM", "xyne-shared"),
    userEmail,
    userName,
    userPassword: optionalEnv("KEYCLOAK_USER_PASSWORD"),
    temporaryPassword: booleanEnv("KEYCLOAK_USER_TEMPORARY_PASSWORD", false),
    workspaceExternalId: requiredEnv("KEYCLOAK_USER_WORKSPACE_EXTERNAL_ID"),
    workspaceClaim:
      process.env.KEYCLOAK_WORKSPACE_CLAIM?.trim() ||
      DEFAULT_KEYCLOAK_WORKSPACE_CLAIM,
    userRole: parseUserRole(process.env.KEYCLOAK_USER_ROLE),
    databaseUrl:
      process.env.DATABASE_URL ||
      `postgres://xyne:xyne@${process.env.DATABASE_HOST || "localhost"}:5432/xyne`,
  }
}

class KeycloakAdminClient {
  private accessToken = ""
  private readonly config: ProvisionConfig

  constructor(config: ProvisionConfig) {
    this.config = config
  }

  async authenticate() {
    const tokenUrl = buildUrl(
      this.config.keycloakInternalBaseUrl,
      "/realms/master/protocol/openid-connect/token",
    )
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: this.config.keycloakAdmin,
        password: this.config.keycloakAdminPassword,
      }),
    })

    if (!response.ok) {
      throw new Error(
        `Failed to authenticate to Keycloak Admin API: ${response.status} ${await response.text()}`,
      )
    }

    const data = (await response.json()) as { access_token?: string }
    if (!data.access_token) {
      throw new Error(
        "Keycloak Admin API token response did not include access_token",
      )
    }
    this.accessToken = data.access_token
  }

  async get<T>(path: string): Promise<T | null> {
    const response = await this.request(path, { method: "GET" })
    if (response.status === 404) {
      return null
    }
    await this.assertOk(response, path)
    return (await response.json()) as T
  }

  async post(path: string, body: unknown) {
    const response = await this.request(path, {
      method: "POST",
      body: JSON.stringify(body),
    })
    await this.assertOk(response, path, [200, 201, 204])
  }

  async put(path: string, body: unknown) {
    const response = await this.request(path, {
      method: "PUT",
      body: JSON.stringify(body),
    })
    await this.assertOk(response, path, [200, 204])
  }

  private request(path: string, init: RequestInit) {
    return fetch(buildUrl(this.config.keycloakInternalBaseUrl, path), {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessToken}`,
        ...init.headers,
      },
    })
  }

  private async assertOk(response: Response, path: string, okStatuses = [200]) {
    if (okStatuses.includes(response.status)) {
      return
    }

    throw new Error(
      `Keycloak Admin API request failed for ${path}: ${response.status} ${await response.text()}`,
    )
  }
}

const realmPath = (realm: string) =>
  `/admin/realms/${encodeURIComponent(realm)}`

const realmResourcePath = (realm: string, resource: string) =>
  `${realmPath(realm)}${resource}`

const ensureWorkspaceUserProfileAttribute = async (
  keycloak: KeycloakAdminClient,
  config: ProvisionConfig,
) => {
  const profilePath = realmResourcePath(config.realm, "/users/profile")
  const profile = await keycloak.get<KeycloakUserProfileConfig>(profilePath)
  if (!profile) {
    throw new Error(`Could not load Keycloak user profile for ${config.realm}`)
  }

  const attributes = profile.attributes || []
  const desiredAttribute = {
    name: config.workspaceClaim,
    displayName: "Xyne workspace external id",
    permissions: {
      view: ["admin"],
      edit: ["admin"],
    },
    multivalued: false,
  }
  const existingIndex = attributes.findIndex(
    (attribute) => attribute.name === config.workspaceClaim,
  )

  if (existingIndex === -1) {
    await keycloak.put(profilePath, {
      ...profile,
      attributes: [...attributes, desiredAttribute],
    })
    console.log(`Created Keycloak user profile attribute ${config.workspaceClaim}`)
    return
  }

  const existingAttribute = attributes[existingIndex] || desiredAttribute
  const updatedAttributes = [...attributes]
  updatedAttributes[existingIndex] = {
    ...existingAttribute,
    ...desiredAttribute,
    permissions: {
      ...(existingAttribute.permissions || {}),
      ...desiredAttribute.permissions,
    },
  }
  await keycloak.put(profilePath, {
    ...profile,
    attributes: updatedAttributes,
  })
  console.log(`Updated Keycloak user profile attribute ${config.workspaceClaim}`)
}

const getUserByEmail = async (
  keycloak: KeycloakAdminClient,
  realm: string,
  email: string,
) => {
  const usersByUsername = await keycloak.get<KeycloakUserRepresentation[]>(
    realmResourcePath(
      realm,
      `/users?username=${encodeURIComponent(email)}&exact=true`,
    ),
  )
  const usernameMatch = usersByUsername?.find(
    (user) => user.username?.toLowerCase() === email.toLowerCase(),
  )
  if (usernameMatch) {
    return usernameMatch
  }

  const usersByEmail = await keycloak.get<KeycloakUserRepresentation[]>(
    realmResourcePath(
      realm,
      `/users?email=${encodeURIComponent(email)}&exact=true`,
    ),
  )
  return (
    usersByEmail?.find(
      (user) => user.email?.toLowerCase() === email.toLowerCase(),
    ) || null
  )
}

const resetUserPassword = async (
  keycloak: KeycloakAdminClient,
  realm: string,
  userId: string,
  password: string,
  temporary: boolean,
) => {
  await keycloak.put(
    realmResourcePath(realm, `/users/${userId}/reset-password`),
    {
      type: "password",
      value: password,
      temporary,
    },
  )
}

const withWorkspaceAttribute = (
  attributes: KeycloakUserRepresentation["attributes"] | undefined,
  config: ProvisionConfig,
) => ({
  ...(attributes || {}),
  [config.workspaceClaim]: [config.workspaceExternalId],
})

const ensureKeycloakUser = async (
  keycloak: KeycloakAdminClient,
  config: ProvisionConfig,
) => {
  let user = await getUserByEmail(keycloak, config.realm, config.userEmail)
  const [firstName, ...restName] = config.userName.split(" ")
  const lastName = restName.join(" ")

  if (!user && !config.userPassword) {
    throw new Error("KEYCLOAK_USER_PASSWORD is required for new users")
  }

  if (!user) {
    await keycloak.post(realmResourcePath(config.realm, "/users"), {
      username: config.userEmail,
      email: config.userEmail,
      enabled: true,
      firstName: firstName || config.userName,
      lastName,
      attributes: withWorkspaceAttribute(undefined, config),
    })
    user = await getUserByEmail(keycloak, config.realm, config.userEmail)
    if (!user?.id || !config.userPassword) {
      throw new Error(
        `Created Keycloak user ${config.userEmail}, but could not reset its password`,
      )
    }
    await resetUserPassword(
      keycloak,
      config.realm,
      user.id,
      config.userPassword,
      config.temporaryPassword,
    )
    console.log(`Created Keycloak user ${config.userEmail}`)
    return
  }

  if (!user.id) {
    throw new Error(`Keycloak user ${config.userEmail} did not include id`)
  }

  await keycloak.put(realmResourcePath(config.realm, `/users/${user.id}`), {
    ...user,
    enabled: true,
    email: config.userEmail,
    username: user.username || config.userEmail,
    firstName: firstName || config.userName,
    lastName,
    attributes: withWorkspaceAttribute(user.attributes, config),
  })

  if (config.userPassword) {
    await resetUserPassword(
      keycloak,
      config.realm,
      user.id,
      config.userPassword,
      config.temporaryPassword,
    )
  }
  console.log(`Updated Keycloak user ${config.userEmail}`)
}

const ensureXyneUser = async (config: ProvisionConfig) => {
  const queryClient = postgres(config.databaseUrl, { idle_timeout: 1 })
  const db = drizzle(queryClient, { schema: { users, workspaces } })

  try {
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.externalId, config.workspaceExternalId))
      .limit(1)

    if (!workspace) {
      throw new Error(
        `Xyne workspace ${config.workspaceExternalId} does not exist`,
      )
    }

    const [existingUser] = await db
      .select()
      .from(users)
      .where(sql`LOWER(${users.email}) = LOWER(${config.userEmail})`)
      .limit(1)

    if (
      existingUser &&
      existingUser.workspaceExternalId !== config.workspaceExternalId
    ) {
      throw new Error(
        `Xyne user ${config.userEmail} already exists in workspace ${existingUser.workspaceExternalId}, expected ${config.workspaceExternalId}`,
      )
    }

    if (!existingUser) {
      await db.insert(users).values({
        externalId: createId(),
        workspaceId: workspace.id,
        email: config.userEmail,
        name: config.userName,
        photoLink: "",
        workspaceExternalId: workspace.externalId,
        lastLogin: new Date(),
        role: config.userRole,
        refreshToken: "",
      })
      console.log(`Created Xyne user ${config.userEmail}`)
      return
    }

    if (
      existingUser.name !== config.userName ||
      existingUser.role !== config.userRole ||
      existingUser.workspaceId !== workspace.id
    ) {
      await db
        .update(users)
        .set({
          workspaceId: workspace.id,
          workspaceExternalId: workspace.externalId,
          name: config.userName,
          role: config.userRole,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(users.id, existingUser.id),
            eq(users.workspaceExternalId, config.workspaceExternalId),
          ),
        )
      console.log(`Updated Xyne user ${config.userEmail}`)
    } else {
      console.log(`Xyne user ${config.userEmail} already exists`)
    }
  } finally {
    await queryClient.end({ timeout: 5 })
  }
}

const main = async () => {
  const config = getProvisionConfig()
  const keycloak = new KeycloakAdminClient(config)

  await keycloak.authenticate()
  await ensureWorkspaceUserProfileAttribute(keycloak, config)
  await ensureXyneUser(config)
  await ensureKeycloakUser(keycloak, config)

  console.log(
    `Provisioned ${config.userEmail} in realm ${config.realm} for workspace ${config.workspaceExternalId}`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

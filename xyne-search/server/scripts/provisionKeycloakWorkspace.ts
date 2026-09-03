import { and, eq, ne } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { workspaces } from "@/platform/db/schema/workspaces"

type WorkspaceOption = {
  externalId: string
  name: string
}

type KeycloakUserProfileAttribute = {
  name: string
  displayName?: string
  permissions?: {
    view?: string[]
    edit?: string[]
  }
  validations?: Record<string, unknown>
  annotations?: Record<string, unknown>
  multivalued?: boolean
  [key: string]: unknown
}

type KeycloakUserProfileConfig = {
  attributes?: KeycloakUserProfileAttribute[]
  [key: string]: unknown
}

type ProvisionWorkspaceConfig = {
  keycloakInternalBaseUrl: string
  keycloakAdmin: string
  keycloakAdminPassword: string
  realm: string
  workspaceClaim: string
  workspaceExternalId: string
  workspaceName: string
  workspaceDomain: string
  workspaceCreatedBy: string
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

const getProvisionWorkspaceConfig = (): ProvisionWorkspaceConfig => {
  const keycloakPort = process.env.KEYCLOAK_PORT?.trim() || "8082"
  const keycloakPublicBaseUrl = requiredEnv(
    "KEYCLOAK_PUBLIC_BASE_URL",
    `http://localhost:${keycloakPort}`,
  )
  const keycloakInternalBaseUrl = requiredEnv(
    "KEYCLOAK_INTERNAL_BASE_URL",
    keycloakPublicBaseUrl,
  )

  return {
    keycloakInternalBaseUrl,
    keycloakAdmin: requiredEnv("KEYCLOAK_ADMIN", "admin"),
    keycloakAdminPassword: requiredEnv("KEYCLOAK_ADMIN_PASSWORD", "admin"),
    realm: requiredEnv("KEYCLOAK_REALM", "xyne-shared"),
    workspaceClaim:
      process.env.KEYCLOAK_WORKSPACE_CLAIM?.trim() ||
      DEFAULT_KEYCLOAK_WORKSPACE_CLAIM,
    workspaceExternalId: requiredEnv("XYNE_WORKSPACE_EXTERNAL_ID"),
    workspaceName: requiredEnv("XYNE_WORKSPACE_NAME"),
    workspaceDomain: requiredEnv("XYNE_WORKSPACE_DOMAIN"),
    workspaceCreatedBy: requiredEnv("XYNE_WORKSPACE_CREATED_BY"),
    databaseUrl:
      process.env.DATABASE_URL ||
      `postgres://xyne:xyne@${process.env.DATABASE_HOST || "localhost"}:5432/xyne`,
  }
}

class KeycloakAdminClient {
  private accessToken = ""
  private readonly config: ProvisionWorkspaceConfig

  constructor(config: ProvisionWorkspaceConfig) {
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

const ensureXyneWorkspace = async (
  config: ProvisionWorkspaceConfig,
): Promise<WorkspaceOption[]> => {
  const queryClient = postgres(config.databaseUrl, { idle_timeout: 1 })
  const db = drizzle(queryClient, { schema: { workspaces } })

  try {
    const [workspaceWithDomain] = await db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.domain, config.workspaceDomain),
          ne(workspaces.externalId, config.workspaceExternalId),
        ),
      )
      .limit(1)

    if (workspaceWithDomain) {
      throw new Error(
        `Workspace domain ${config.workspaceDomain} is already used by ${workspaceWithDomain.externalId}`,
      )
    }

    const [workspaceWithCreator] = await db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.createdBy, config.workspaceCreatedBy),
          ne(workspaces.externalId, config.workspaceExternalId),
        ),
      )
      .limit(1)

    if (workspaceWithCreator) {
      throw new Error(
        `Workspace creator ${config.workspaceCreatedBy} is already used by ${workspaceWithCreator.externalId}`,
      )
    }

    const [existingWorkspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.externalId, config.workspaceExternalId))
      .limit(1)

    if (!existingWorkspace) {
      await db.insert(workspaces).values({
        externalId: config.workspaceExternalId,
        name: config.workspaceName,
        domain: config.workspaceDomain,
        createdBy: config.workspaceCreatedBy,
      })
      console.log(`Created Xyne workspace ${config.workspaceExternalId}`)
    } else if (
      existingWorkspace.name !== config.workspaceName ||
      existingWorkspace.domain !== config.workspaceDomain
    ) {
      await db
        .update(workspaces)
        .set({
          name: config.workspaceName,
          domain: config.workspaceDomain,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.externalId, config.workspaceExternalId))
      console.log(`Updated Xyne workspace ${config.workspaceExternalId}`)
    } else {
      console.log(`Xyne workspace ${config.workspaceExternalId} already exists`)
    }

    const workspaceRows = await db
      .select({
        externalId: workspaces.externalId,
        name: workspaces.name,
      })
      .from(workspaces)
      .orderBy(workspaces.name)

    return workspaceRows
  } finally {
    await queryClient.end({ timeout: 5 })
  }
}

const getWorkspaceLabels = (workspaceOptions: WorkspaceOption[]) =>
  Object.fromEntries(
    workspaceOptions.map((workspace) => [
      workspace.externalId,
      `${workspace.name} (${workspace.externalId})`,
    ]),
  )

const syncWorkspaceDropdown = async (
  keycloak: KeycloakAdminClient,
  config: ProvisionWorkspaceConfig,
  workspaceOptions: WorkspaceOption[],
) => {
  const profilePath = realmResourcePath(config.realm, "/users/profile")
  const profile = await keycloak.get<KeycloakUserProfileConfig>(profilePath)
  if (!profile) {
    throw new Error(`Could not load Keycloak user profile for ${config.realm}`)
  }

  const attributes = profile.attributes || []
  const options = workspaceOptions.map((workspace) => workspace.externalId)
  const labels = getWorkspaceLabels(workspaceOptions)
  const desiredAttribute: KeycloakUserProfileAttribute = {
    name: config.workspaceClaim,
    displayName: "Xyne workspace",
    permissions: {
      view: ["admin"],
      edit: ["admin"],
    },
    validations: {
      options: {
        options,
      },
    },
    annotations: {
      inputType: "select",
      inputOptionLabels: labels,
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
    console.log(`Created Keycloak workspace dropdown ${config.workspaceClaim}`)
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
    validations: {
      ...(existingAttribute.validations || {}),
      ...desiredAttribute.validations,
    },
    annotations: {
      ...(existingAttribute.annotations || {}),
      ...desiredAttribute.annotations,
    },
  }

  await keycloak.put(profilePath, {
    ...profile,
    attributes: updatedAttributes,
  })
  console.log(`Updated Keycloak workspace dropdown ${config.workspaceClaim}`)
}

const main = async () => {
  const config = getProvisionWorkspaceConfig()
  const workspaceOptions = await ensureXyneWorkspace(config)
  const keycloak = new KeycloakAdminClient(config)

  await keycloak.authenticate()
  await syncWorkspaceDropdown(keycloak, config, workspaceOptions)

  console.log(
    `Provisioned workspace ${config.workspaceExternalId} and synced ${workspaceOptions.length} Keycloak workspace options`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

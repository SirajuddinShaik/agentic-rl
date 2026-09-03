import { createId } from "@paralleldrive/cuid2"
import { db } from "./client"
export { db }
import {
  connectors,
  ingestionStateSchema,
  oauthProviders,
  selectConnectorSchema,
  users,
  type IngestionStateUnion,
  type SelectConnector,
  type SelectOAuthProvider,
} from "./schema"
import type {
  MicrosoftServiceCredentials,
  OAuthCredentials,
  TxnOrClient,
} from "@/types"
import { Subsystem } from "@/types"
import { and, eq, sql } from "drizzle-orm"
import { Apps, AuthType, ConnectorStatus, ConnectorType } from "@/platform/shared/types"
import { Google, MicrosoftEntraId } from "arctic"
import config from "@/config"
import { getLogger } from "@/platform/logger"
import {
  ConnectionInsertionError,
  NoConnectorsFound,
  NoOauthConnectorFound,
  MissingOauthConnectorCredentialsError,
  FetchProviderFailed,
  UpdateConnectorFailed,
} from "@/platform/errors"
import { IsGoogleApp, IsMicrosoftApp } from "@/utils"
import { getOAuthProviderByConnectorId } from "@/platform/db/oauthProvider"
import { getErrorMessage } from "@/utils"
import { syncJobs } from "@/platform/db/schema"
import { createCollection } from "@/platform/db/knowledgeBase"
import { scopes } from "@/integrations/microsoft/config"
import { CustomServiceAuthProvider } from "@/integrations/microsoft/utils"
const Logger = getLogger(Subsystem.Db).child({ module: "connector" })

export const insertConnector = async (
  trx: TxnOrClient,
  workspaceId: number,
  userId: number,
  workspaceExternalId: string,
  name: string,
  type: ConnectorType,
  authType: AuthType,
  app: Apps,
  config: Record<string, any>,
  credentials: string | null,
  subject: string | null,
  oauthCredentials?: string | null,
  apiKey?: string | null,
  status?: ConnectorStatus | null,
) => {
  const externalId = createId()
  try {
    const inserted = await trx
      .insert(connectors)
      .values({
        workspaceId,
        userId,
        workspaceExternalId,
        externalId: externalId,
        name: name,
        type: type,
        authType: authType,
        app: app,
        config: config,
        credentials,
        subject,
        oauthCredentials,
        apiKey,
        ...(status ? { status } : {}),
      })
      .returning()
    Logger.info("Connection inserted successfully")
    return inserted[0]
  } catch (error) {
    Logger.error(
      error,
      `Error inserting connection:, ${error} \n ${(error as Error).stack}`,
    )
    throw new ConnectionInsertionError({
      message: "Could not insert connection",
      cause: error as Error,
    })
  }
}

export const getConnectors = async (workspaceId: string, userId: number) => {
  const res = await db
    .select({
      id: connectors.externalId,
      internalId: connectors.id,
      name: connectors.name,
      app: connectors.app,
      authType: connectors.authType,
      type: connectors.type,
      status: connectors.status,
      createdAt: connectors.createdAt,
      config: connectors.config,
      state: connectors.state,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.workspaceExternalId, workspaceId),
        eq(connectors.userId, userId),
      ),
    )
  return res
}

export const getConnectorByApp = async (
  trx: TxnOrClient,
  app: Apps,
): Promise<SelectConnector> => {
  const res = await trx
    .select()
    .from(connectors)
    .where(and(eq(connectors.app, app)))
    .limit(1)
  if (res.length) {
    const parsedRes = selectConnectorSchema.safeParse(res[0])
    if (!parsedRes.success) {
      throw parsedRes.error
    }
    // TODO: maybe add a check if OAuth and expired token then throw error
    return parsedRes.data
  } else {
    throw new NoConnectorsFound({
      message: `Could not get the connector with type: ${app}`,
    })
  }
}

// Prefer getOAuthConnectorWithCredentials: this does not refresh expired tokens
export const getConnector = async (
  _trx: TxnOrClient,
  connectorId: number,
): Promise<SelectConnector> => {
  const res = await db
    .select()
    .from(connectors)
    .where(eq(connectors.id, connectorId))
    .limit(1)
  if (res.length) {
    const parsedRes = selectConnectorSchema.safeParse(res[0])
    if (!parsedRes.success) {
      throw parsedRes.error
    }
    // TODO: maybe add a check if OAuth and expired token then throw error
    return parsedRes.data
  } else {
    throw new NoConnectorsFound({
      message: `Could not get the connector with id: ${connectorId}`,
    })
  }
}

const IsTokenExpired = (
  app: Apps,
  oauthCredentials: OAuthCredentials,
  bufferInSeconds: number,
): boolean => {
  if (IsGoogleApp(app) || IsMicrosoftApp(app)) {
    const tokens = oauthCredentials.data
    const now: Date = new Date()
    // accessTokenExpiresAt is stored stringified; coerce back to Date
    const expirationTime = new Date(tokens.accessTokenExpiresAt).getTime()
    const currentTime = now.getTime()
    return currentTime + bufferInSeconds * 1000 > expirationTime
  }
  return false
}

const IsExpired = (
  _app: Apps,
  expiresAt: Date,
  bufferInSeconds: number,
): boolean => {
  const now: Date = new Date()
  const currentTime = now.getTime()
  const expirationTime = new Date(expiresAt).getTime()
  return currentTime + bufferInSeconds * 1000 > expirationTime
}

// Guarantees a valid access token on the returned connector, refreshing in place if expired
export const getOAuthConnectorWithCredentials = async (
  trx: TxnOrClient,
  connectorId: number,
): Promise<SelectConnector> => {
  const res = await trx
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.id, connectorId),
        eq(connectors.authType, AuthType.OAuth),
      ),
    )
    .limit(1)

  if (!res.length) {
    throw new NoOauthConnectorFound({
      message: `Could not get the oauth connector with id:  ${connectorId}`,
    })
  }

  const oauthRes: SelectConnector = selectConnectorSchema.parse(res[0])

  if (!oauthRes.oauthCredentials) {
    throw new MissingOauthConnectorCredentialsError({})
  }
  oauthRes.oauthCredentials = JSON.parse(oauthRes.oauthCredentials as string)

  // Google/Microsoft tokens live ~1h; refresh within a 5-min buffer of expiry
  if (
    IsTokenExpired(
      oauthRes.app,
      oauthRes.oauthCredentials as OAuthCredentials,
      5 * 60,
    )
  ) {
    if (IsGoogleApp(oauthRes.app)) {
      const providers: SelectOAuthProvider[] =
        await getOAuthProviderByConnectorId(trx, connectorId)

      if (!providers.length) {
        Logger.error("Could not fetch provider while refreshing Google Token")
        throw new FetchProviderFailed({
          message: "Could not fetch provider while refreshing Google Token",
        })
      }
      const [googleProvider] = providers
      if (!googleProvider) {
        Logger.error("Could not fetch provider while refreshing Google Token")
        throw new FetchProviderFailed({
          message: "Could not fetch provider while refreshing Google Token",
        })
      }
      const google = new Google(
        googleProvider.clientId!,
        googleProvider.clientSecret as string,
        `${config.host}/oauth/callback`,
      )
      const tokens = (oauthRes.oauthCredentials as OAuthCredentials).data
      const refreshedTokens = await google.refreshAccessToken(
        tokens.refresh_token,
      )
      tokens.access_token = refreshedTokens.accessToken()
      tokens.accessTokenExpiresAt = new Date(
        refreshedTokens.accessTokenExpiresAt(),
      )
      ;(oauthRes.oauthCredentials as OAuthCredentials).data = tokens
      const updatedConnector = await updateConnector(trx, oauthRes.id, {
        oauthCredentials: JSON.stringify(oauthRes.oauthCredentials),
      })
      Logger.info(`Connector successfully updated: ${updatedConnector.id}`)
    } else if (IsMicrosoftApp(oauthRes.app)) {
      const providers: SelectOAuthProvider[] =
        await getOAuthProviderByConnectorId(trx, connectorId)

      if (!providers.length) {
        Logger.error(
          "Could not fetch provider while refreshing Microsoft Token",
        )
        throw new FetchProviderFailed({
          message: "Could not fetch provider while refreshing Microsoft Token",
        })
      }
      const [microsoftProvider] = providers
      if (!microsoftProvider) {
        Logger.error(
          "Could not fetch provider while refreshing Microsoft Token",
        )
        throw new FetchProviderFailed({
          message: "Could not fetch provider while refreshing Microsoft Token",
        })
      }
      const microsoft = new MicrosoftEntraId(
        "common",
        microsoftProvider.clientId!,
        microsoftProvider.clientSecret as string,
        `${config.host}/oauth/callback`,
      )
      const tokens = (oauthRes.oauthCredentials as OAuthCredentials).data
      const refreshedTokens = await microsoft.refreshAccessToken(
        tokens.refresh_token,
        scopes,
      )
      tokens.access_token = refreshedTokens.accessToken()
      tokens.accessTokenExpiresAt = new Date(
        refreshedTokens.accessTokenExpiresAt(),
      )
      // Microsoft rotates refresh tokens; persist the new one when returned
      if (refreshedTokens.refreshToken()) {
        tokens.refresh_token = refreshedTokens.refreshToken()
      }
      ;(oauthRes.oauthCredentials as OAuthCredentials).data = tokens
      const updatedConnector = await updateConnector(trx, oauthRes.id, {
        oauthCredentials: JSON.stringify(oauthRes.oauthCredentials),
      })
      Logger.info(
        `Microsoft connector successfully updated: ${updatedConnector.id}`,
      )
    } else {
      Logger.error(
        `Token has to refresh but ${oauthRes.app} app not yet supported`,
      )
      throw new Error(
        `Token has to refresh but ${oauthRes.app} app not yet supported`,
      )
    }
  }
  return oauthRes
}

export const getMicrosoftAuthConnectorWithCredentials = async (
  trx: TxnOrClient,
  connectorId: number,
): Promise<SelectConnector> => {
  const res = await trx
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.id, connectorId),
        eq(connectors.authType, AuthType.ServiceAccount),
      ),
    )
    .limit(1)

  if (!res.length) {
    throw new NoOauthConnectorFound({
      message: `Could not get the oauth connector with id:  ${connectorId}`,
    })
  }

  let authRes: SelectConnector = selectConnectorSchema.parse(res[0])

  if (!authRes.credentials) {
    throw new MissingOauthConnectorCredentialsError({})
  }
  const credentials: MicrosoftServiceCredentials = JSON.parse(
    authRes.credentials as string,
  )

  if (IsExpired(authRes.app, new Date(credentials.expires_at), 5 * 60)) {
    if (IsMicrosoftApp(authRes.app)) {
      const authProvider = new CustomServiceAuthProvider(
        credentials.tenantId,
        credentials.clientId,
        credentials.clientSecret,
      )

      const accessToken = await authProvider.getAccessTokenWithExpiry()
      credentials.access_token = accessToken.token
      credentials.expires_at = new Date(
        accessToken.expiresOnTimestamp,
      ).toISOString()

      authRes = await updateConnector(trx, authRes.id, {
        credentials: JSON.stringify(credentials),
      })
      Logger.info(`Microsoft connector successfully updated: ${authRes.id}`)
    } else {
      Logger.error(
        `Token has to refresh but ${authRes.app} app not yet supported`,
      )
      throw new Error(
        `Token has to refresh but ${authRes.app} app not yet supported`,
      )
    }
  }
  return authRes
}

export const getConnectorByExternalId = async (
  trx: TxnOrClient,
  connectorId: string,
  userId: number,
): Promise<SelectConnector> => {
  const res = await trx
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.externalId, connectorId),
        eq(connectors.userId, userId),
      ),
    )
    .limit(1)
  if (res.length) {
    const parsedRes = selectConnectorSchema.safeParse(res[0])
    if (!parsedRes.success) {
      Logger.error(
        `Failed to parse connector data for externalId ${connectorId}: ${parsedRes.error.toString()}`,
      )
      throw new NoConnectorsFound({
        message: `Could not parse connector data for externalId: ${connectorId}`,
      })
    }
    return parsedRes.data
  } else {
    Logger.error(
      `Connector not found for external ID ${connectorId} and user ID ${userId}`,
    )
    throw new NoConnectorsFound({
      message: `Connector not found for external ID ${connectorId} and user ID ${userId}`,
    })
  }
}

export const getConnectorById = async (
  trx: TxnOrClient,
  connectorId: number,
  userId: number,
): Promise<SelectConnector> => {
  const res = await trx
    .select()
    .from(connectors)
    .where(and(eq(connectors.id, connectorId), eq(connectors.userId, userId)))
    .limit(1)
  if (res.length) {
    const parsedRes = selectConnectorSchema.safeParse(res[0])
    if (!parsedRes.success) {
      Logger.error(
        `Failed to parse connector data for id ${connectorId}: ${parsedRes.error.toString()}`,
      )
      throw new NoConnectorsFound({
        message: `Could not parse connector data for id: ${connectorId}`,
      })
    }
    return parsedRes.data
  } else {
    Logger.error(
      `Connector not found for ID ${connectorId} and user ID ${userId}`,
    )
    throw new NoConnectorsFound({
      message: `Connector not found for ID ${connectorId} and user ID ${userId}`,
    })
  }
}

export const getConnectorByAppAndEmailId = async (
  trx: TxnOrClient,
  app: Apps,
  _authType: AuthType,
  emailId: string,
): Promise<SelectConnector> => {
  const res = await trx
    .select()
    .from(connectors)
    .innerJoin(users, eq(connectors.userId, users.id))
    .where(and(eq(connectors.app, app), eq(users.email, emailId)))
    .limit(1)
  const row = res[0]
  if (row) {
    const parsedRes = selectConnectorSchema.safeParse(row.connectors)
    if (!parsedRes.success) {
      Logger.error(`Failed to parse connector data for user:${emailId} `)
      throw new NoConnectorsFound({
        message: `Could not parse connector data for user: ${emailId}`,
      })
    }
    return parsedRes.data
  } else {
    Logger.error(`Connector not found for emailID ${emailId} and app  ${app}`)
    throw new NoConnectorsFound({
      message: `Connector not found for emailID ${emailId} and app  ${app}`,
    })
  }
}

export const updateConnector = async (
  trx: TxnOrClient,
  connectorId: number,
  updateData: Partial<typeof connectors.$inferInsert>, // TODO: restrict updatable fields
): Promise<SelectConnector> => {
  const updatedConnectors = await trx
    .update(connectors)
    .set(updateData)
    .where(eq(connectors.id, connectorId))
    .returning()

  if (!updatedConnectors || !updatedConnectors.length) {
    Logger.error(`Could not update connector`)
    throw new UpdateConnectorFailed("Could not update connector")
  }
  const [connectorVal] = updatedConnectors
  return selectConnectorSchema.parse(connectorVal)
}

export const deleteConnector = async (
  trx: TxnOrClient,
  connectorId: string,
  userId: number,
): Promise<void> => {
  const connector = await trx
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.externalId, connectorId),
        eq(connectors.userId, userId),
      ),
    )
    .limit(1)

  const connectorRow = connector[0]
  if (!connectorRow) {
    Logger.warn(`Connector not found: ${connectorId}`)
    return
  }

  const internalConnectorId = connectorRow.id

  // Delete ingestions first; they reference connectors via foreign key
  const { ingestions } = await import("./schema")
  await trx
    .delete(ingestions)
    .where(eq(ingestions.connectorId, internalConnectorId))
  Logger.debug(`Deleted ingestions for connector: ${connectorId}`)

  return await trx
    .delete(connectors)
    .where(
      and(
        eq(connectors.externalId, connectorId),
        eq(connectors.userId, userId),
      ),
    )
}

export const deleteOauthConnector = async (
  trx: TxnOrClient,
  connectorId: number,
): Promise<void> => {
  Logger.info(
    `Attempting to delete OAuth connector and related data for connector ID: ${connectorId}`,
  )
  try {
    // Delete FK-referencing rows before the connector itself
    const { ingestions } = await import("./schema")
    await trx.delete(ingestions).where(eq(ingestions.connectorId, connectorId))
    Logger.debug(`Deleted ingestions for connector ID: ${connectorId}`)

    await trx.delete(syncJobs).where(eq(syncJobs.connectorId, connectorId))
    Logger.debug(`Deleted sync jobs for connector ID: ${connectorId}`)

    await trx
      .delete(oauthProviders)
      .where(eq(oauthProviders.connectorId, connectorId))
    Logger.debug(`Deleted OAuth providers for connector ID: ${connectorId}`)

    await trx.delete(connectors).where(eq(connectors.id, connectorId))
    Logger.info(`Successfully deleted connector ID: ${connectorId}`)
  } catch (error) {
    Logger.error(
      { error, connectorId },
      `Error deleting connector and related data: ${getErrorMessage(error)}`,
    )
    throw new Error(
      `Failed to delete connector ${connectorId}: ${getErrorMessage(error)}`,
    )
  }
}

export async function loadConnectorState<T extends IngestionStateUnion>(
  trx: TxnOrClient,
  connectorId: number,
  workspaceId: number,
  userId: number,
): Promise<T | null> {
  const result = await trx
    .select({ state: connectors.state })
    .from(connectors)
    .where(
      and(
        eq(connectors.id, connectorId),
        eq(connectors.workspaceId, workspaceId),
        eq(connectors.userId, userId),
      ),
    )
    .limit(1)

  const row = result[0]
  if (!row) {
    Logger.warn(
      `No connector found for id=${connectorId}, workspaceId=${workspaceId}, userId=${userId}`,
    )
    return null
  }

  const state = row.state as Record<string, any>
  if (Object.keys(state).length === 0) {
    return null // Treat empty object as no state
  }
  const parsedState = ingestionStateSchema.safeParse(row.state)
  if (parsedState.success) {
    return parsedState.data as T
  } else {
    Logger.warn(
      `Invalid state format for connector ${connectorId}: ${parsedState.error}`,
    )
    return null
  }
}

export async function saveConnectorState<T extends IngestionStateUnion>(
  trx: TxnOrClient,
  connectorId: number,
  workspaceId: number,
  userId: number,
  state: T,
): Promise<void> {
  const updated = await trx
    .update(connectors)
    .set({ state })
    .where(
      and(
        eq(connectors.id, connectorId),
        eq(connectors.workspaceId, workspaceId),
        eq(connectors.userId, userId),
      ),
    )
    .returning({ id: connectors.id })

  if (updated.length === 0) {
    Logger.error(
      `Failed to update state for connector id=${connectorId}, workspaceId=${workspaceId}, userId=${userId}`,
    )
    throw new UpdateConnectorFailed(
      `Could not update state for connector ${connectorId}`,
    )
  }

  Logger.debug(`State saved for connector ${connectorId}`)
}

// connectorId may be the numeric id or the externalId; scoped to user + workspace.
export async function getDatabaseConnectorForUser(
  trx: TxnOrClient,
  connectorId: string,
  userId: number,
  workspaceId: number,
) {
  const byNumericId = /^\d+$/.test(connectorId)
  const rows = await trx
    .select()
    .from(connectors)
    .where(
      and(
        byNumericId
          ? eq(connectors.id, Number(connectorId))
          : eq(connectors.externalId, connectorId),
        eq(connectors.userId, userId),
        eq(connectors.workspaceId, workspaceId),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

/**
 * Get or create state.kbCollectionId for a database connector (numeric id or externalId).
 * SELECT FOR UPDATE in a txn prevents two callers from both creating a collection.
 */
export async function getOrCreateDatabaseConnectorKbCollectionId(
  connectorId: string,
): Promise<string> {
  const byNumericId = /^\d+$/.test(connectorId)
  return await db.transaction(async (tx) => {
    const [conn] = await tx
      .select({
        id: connectors.id,
        state: connectors.state,
        name: connectors.name,
        workspaceId: connectors.workspaceId,
        userId: connectors.userId,
      })
      .from(connectors)
      .where(
        byNumericId ? eq(connectors.id, Number(connectorId)) : eq(connectors.externalId, connectorId),
      )
      .limit(1)
      .for("update")
    if (!conn) throw new Error("Connector not found")
    const state = (conn.state as Record<string, unknown>) || {}
    if (typeof state.kbCollectionId === "string") return state.kbCollectionId
    const coll = await createCollection(tx, {
      workspaceId: conn.workspaceId,
      ownerId: conn.userId,
      name: `Database: ${conn.name}`,
    })
    await tx
      .update(connectors)
      .set({
        state: { ...state, kbCollectionId: coll.id } as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(connectors.id, conn.id))
    return coll.id
  })
}

// Reverse lookup for schema docs ingested without a connectorId (matches state.kbCollectionId).
export async function getDatabaseConnectorExternalIdByKbCollectionId(
  collectionId: string,
): Promise<string | null> {
  const rows = await db
    .select({ externalId: connectors.externalId })
    .from(connectors)
    .where(
      and(
        eq(connectors.app, Apps.Database),
        sql`${connectors.state}->>'kbCollectionId' = ${collectionId}`,
      ),
    )
    .limit(1)
  return rows[0]?.externalId ?? null
}

  // Unlink this collection so the next sync creates a fresh one; call on KB collection/item delete.
  export const clearDatabaseConnectorKbCollectionId = async (
    trx: TxnOrClient,
    collectionId: string,
  ): Promise<void> => {
    const rows = await trx
      .select({ id: connectors.id, state: connectors.state })
      .from(connectors)
      .where(
        and(
          eq(connectors.app, Apps.Database),
          sql`${connectors.state}->>'kbCollectionId' = ${collectionId}`,
        ),
      )
    for (const row of rows) {
      const state = (row.state as Record<string, unknown>) || {}
      const { kbCollectionId: _removed, ...rest } = state
      await trx
        .update(connectors)
        .set({
          state: rest as (typeof connectors.$inferInsert)["state"],
          updatedAt: new Date(),
        })
        .where(eq(connectors.id, row.id))
    }
  }
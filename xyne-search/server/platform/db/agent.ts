import {
  agents,
  insertAgentSchema,
  selectAgentSchema,
  selectPublicAgentSchema,
  type InsertAgent,
  type SelectAgent,
  type SelectPublicAgent,
} from "@/platform/db/schema"
export type { SelectAgent }
import { createId } from "@paralleldrive/cuid2"
import { Subsystem, type TxnOrClient } from "@/types"
import { z } from "zod"
import { and, desc, eq, isNull, sql } from "drizzle-orm"
import { UserAgentRole } from "@/platform/shared/types"
import {
  grantUserAgentPermission,
  getUserAccessibleAgents,
  checkUserAgentAccessByExternalId,
  getAgentsMadeByMe,
  getAgentsSharedToMe,
} from "@/platform/db/userAgentPermission"
import { getLoggerWithChild } from "@/platform/logger"
import { getUserByEmail } from "./user"
import { getCollectionById, getCollectionItemById } from "./knowledgeBase"
import { revokeAgentGrants } from "./acl-propagation"

export { getAgentsMadeByMe, getAgentsSharedToMe }

const loggerWithChild = getLoggerWithChild(Subsystem.Db)

// Partial agent-update shape. Fields explicitly admit `undefined` so
// exactOptionalPropertyTypes callers (e.g. Zod-derived UpdateAgentPayload)
// type-check without dropping keys.
type AgentUpdateData = {
  [K in keyof (Omit<InsertAgent, "externalId" | "userId" | "workspaceId"> & {
    ownerEmails?: string[]
    userEmails?: string[]
  })]?:
    | (Omit<InsertAgent, "externalId" | "userId" | "workspaceId"> & {
        ownerEmails?: string[]
        userEmails?: string[]
      })[K]
    | undefined
}

// The agent → KB read-grant ADD path moved to acl-propagation.ts
// (propagateAgentGrants); this legacy permissions[] writer is retired.

// reconcileCollectionGrants / reconcileAgentCollectionGrants (the legacy
// permissions[] revoke path) removed — superseded by the acl propagation engine
// (revokeAgentGrants / repropagateAgentGrants).

export const insertAgent = async (
  trx: TxnOrClient,
  agentData: Omit<InsertAgent, "externalId" | "userId" | "workspaceId"> & {
    ownerEmails?: string[]
    userEmails?: string[]
  },
  userId: number,
  workspaceId: number,
): Promise<SelectAgent> => {
  const { ownerEmails, userEmails, ...dbFields } = agentData
  const externalId = createId()
  const agentWithIds = {
    ...dbFields,
    externalId,
    userId,
    workspaceId,
  }
  const validatedAgentData = insertAgentSchema.parse(agentWithIds)

  const result = await trx.transaction(async (tx) => {
    const agentArr = await tx
      .insert(agents)
      .values(validatedAgentData)
      .returning()

    if (!agentArr || !agentArr.length) {
      throw new Error('Error in insert of agent "returning"')
    }

    const newAgent = selectAgentSchema.parse(agentArr[0])

    await grantUserAgentPermission(tx, {
      userId,
      agentId: newAgent.id,
      role: UserAgentRole.Owner,
    })

    // KB grant propagation now runs at the service layer (AgentsService.create),
    // after the agent's full acl audience is set via syncAgentUserPermissions.

    return newAgent
  })

  return result
}

export const getAgentByExternalId = async (
  trx: TxnOrClient,
  agentExternalId: string,
  _workspaceId: number,
): Promise<SelectAgent | null> => {
  const agentArr = await trx
    .select()
    .from(agents)
    .where(
      and(eq(agents.externalId, agentExternalId), isNull(agents.deletedAt)),
    )
  if (!agentArr || !agentArr.length) {
    return null
  }
  return selectAgentSchema.parse(agentArr[0])
}

export const getAgentByExternalIdWithPermissionCheck = async (
  trx: TxnOrClient,
  agentExternalId: string,
  workspaceId: number,
  userId: number,
): Promise<SelectAgent | null> => {
  const permission = await checkUserAgentAccessByExternalId(
    trx,
    userId,
    agentExternalId,
    workspaceId,
  )

  if (!permission) {
    return null
  }

  return getAgentByExternalId(trx, agentExternalId, workspaceId)
}

/**
 * @deprecated Use getUserAccessibleAgents instead for permission-based access
 */
export const getAgentsByUserId = async (
  trx: TxnOrClient,
  userId: number,
  workspaceId: number,
  limit: number = 50,
  offset: number = 0,
): Promise<SelectPublicAgent[]> => {
  return getUserAccessibleAgents(trx, userId, workspaceId, limit, offset)
}

export const getAgentsAccessibleToUser = async (
  trx: TxnOrClient,
  userId: number,
  workspaceId: number,
  limit: number = 50,
  offset: number = 0,
  isExtractor?: boolean,
): Promise<SelectPublicAgent[]> => {
  return getUserAccessibleAgents(trx, userId, workspaceId, limit, offset, isExtractor)
}

// All non-deleted agents across every workspace, regardless of creator.
export const getAllAgents = async (
  trx: TxnOrClient,
  limit: number = 50,
  offset: number = 0,
): Promise<SelectPublicAgent[]> => {
  const agentsArr = await trx
    .select()
    .from(agents)
    .where(and(isNull(agents.deletedAt)))
    .orderBy(desc(agents.updatedAt))
    .limit(limit)
    .offset(offset)
  return z.array(selectPublicAgentSchema).parse(agentsArr)
}

export const updateAgentByExternalId = async (
  trx: TxnOrClient,
  agentExternalId: string,
  workspaceId: number,
  agentData: AgentUpdateData,
): Promise<SelectAgent | null> => {
  const { ownerEmails, userEmails, ...dbFields } = agentData
  const updateData = { ...dbFields, updatedAt: new Date() }

  const agentArr = await trx
    .update(agents)
    .set(updateData)
    .where(
      and(
        eq(agents.externalId, agentExternalId),
        eq(agents.workspaceId, workspaceId),
        isNull(agents.deletedAt),
      ),
    )
    .returning()

  if (!agentArr || !agentArr.length) {
    return null
  }
  const updatedAgent = selectAgentSchema.parse(agentArr[0])

  // KB grant propagation now runs at the service layer (repropagateAgentGrants in
  // AgentsService.update / updateDefault), against the unified acl.

  return updatedAgent
}

// Only Owner or Editor may update.
export const updateAgentByExternalIdWithPermissionCheck = async (
  trx: TxnOrClient,
  agentExternalId: string,
  workspaceId: number,
  userId: number,
  agentData: AgentUpdateData,
): Promise<SelectAgent | null> => {
  const permission = await checkUserAgentAccessByExternalId(
    trx,
    userId,
    agentExternalId,
    workspaceId,
  )
  const requiredUser = permission?.find((user) => user.userId == userId)
  if (
    !requiredUser ||
    (requiredUser.role !== UserAgentRole.Owner &&
      requiredUser.role !== UserAgentRole.Editor)
  ) {
    return null
  }

  return updateAgentByExternalId(trx, agentExternalId, workspaceId, agentData)
}

export const deleteAgentByExternalId = async (
  trx: TxnOrClient,
  agentExternalId: string,
  workspaceId: number,
): Promise<SelectAgent | null> => {
  const agentArr = await trx
    .update(agents)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(agents.externalId, agentExternalId),
        eq(agents.workspaceId, workspaceId),
        isNull(agents.deletedAt), // soft-delete once; skip already-deleted rows
      ),
    )
    .returning()
  if (!agentArr || !agentArr.length) {
    return null
  }
  const deleted = selectAgentSchema.parse(agentArr[0])
  // The agent is gone — drop every KB grant it produced (exact delete-by-source).
  await revokeAgentGrants(trx, deleted.id)
  return deleted
}

// Only Owner may delete.
export const deleteAgentByExternalIdWithPermissionCheck = async (
  trx: TxnOrClient,
  agentExternalId: string,
  workspaceId: number,
  userId: number,
): Promise<SelectAgent | null> => {
  const permission = await checkUserAgentAccessByExternalId(
    trx,
    userId,
    agentExternalId,
    workspaceId,
  )
  const requiredUser = permission?.find((user) => user.userId == userId)
  if (!requiredUser || requiredUser.role !== UserAgentRole.Owner) {
    return null
  }

  return deleteAgentByExternalId(trx, agentExternalId, workspaceId)
}

export const removeAppIntegrationFromAllAgents = async (
  trx: TxnOrClient,
  appIntegrationNameToRemove: string,
): Promise<void> => {
  try {
    const agentsToUpdate = await trx
      .select()
      .from(agents)
      .where(
        sql`${agents.appIntegrations} @> ${JSON.stringify([
          appIntegrationNameToRemove,
        ])}`,
      )

    loggerWithChild().info(
      `Count of agents to update: ${agentsToUpdate.length}`,
    )
    if (agentsToUpdate.length === 0) {
      return
    }

    for (const agent of agentsToUpdate) {
      const currentIntegrations =
        (agent.appIntegrations as string[] | null) || []
      const updatedIntegrations = currentIntegrations.filter(
        (integration) => integration !== appIntegrationNameToRemove,
      )

      await trx
        .update(agents)
        .set({ appIntegrations: updatedIntegrations, updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
    }
  } catch (error) {
    loggerWithChild().error(
      error,
      `Failed to remove app integration "${appIntegrationNameToRemove}" from all agents`,
    )
    throw new Error(
      `Failed to remove app integration: ${appIntegrationNameToRemove}`,
    )
  }
}

export const getAgentsByDataSourceId = async (
  trx: TxnOrClient,
  dataSourceId: string,
): Promise<Pick<SelectAgent, "name" | "externalId">[]> => {
  try {
    const agentsWithDataSource = await trx
      .select({
        name: agents.name,
        externalId: agents.externalId,
      })
      .from(agents)
      .where(
        sql`${agents.appIntegrations} @> ${JSON.stringify([dataSourceId])}`,
      )

    return agentsWithDataSource
  } catch (error) {
    loggerWithChild().error(
      error,
      `Failed to get agents for data source ID "${dataSourceId}"`,
    )
    throw new Error(`Failed to get agents for data source: ${dataSourceId}`)
  }
}

export const cleanUpAgentDb = async (
  trx: TxnOrClient,
  deletedItemIds: string[],
  userEmail: string,
): Promise<void> => {
  if (!deletedItemIds || deletedItemIds.length === 0) {
    loggerWithChild().info("No item IDs provided for agent cleanup")
    return
  }

  try {
    loggerWithChild().info(
      `Starting agent cleanup for deleted item IDs: ${deletedItemIds.join(", ")} requested by ${userEmail}`,
    )

    const users = await getUserByEmail(trx, userEmail)
    const user = users?.[0]
    if (!user) {
      loggerWithChild().warn(`User not found for email: ${userEmail}`)
      return
    }
    const userId = user.id

    // Scope cleanup to agents owned by the requesting user.
    const allActiveAgents = await trx
      .select()
      .from(agents)
      .where(and(isNull(agents.deletedAt), eq(agents.userId, userId)))

    const agentsToUpdate = allActiveAgents.filter((agent) => {
      const currentIntegrations = agent.appIntegrations as any

      if (Array.isArray(currentIntegrations)) {
        return currentIntegrations.some((integration: string) =>
          deletedItemIds.includes(integration),
        )
      } else if (
        currentIntegrations &&
        typeof currentIntegrations === "object"
      ) {
        if (currentIntegrations.knowledge_base?.itemIds) {
          return currentIntegrations.knowledge_base.itemIds.some((id: string) =>
            deletedItemIds.includes(id),
          )
        }
      }
      return false
    })

    loggerWithChild().info(
      `Found ${agentsToUpdate.length} agents with references to deleted items`,
    )

    if (agentsToUpdate.length === 0) {
      return
    }
    let updatedAgentsCount = 0
    for (const agent of agentsToUpdate) {
      const currentIntegrations = agent.appIntegrations as any
      let updatedIntegrations

      loggerWithChild().info(
        `Processing agent ${agent.name} (${agent.externalId}) with integrations: ${JSON.stringify(currentIntegrations)}`,
      )

      if (Array.isArray(currentIntegrations)) {
        updatedIntegrations = currentIntegrations.filter(
          (integration: string) => !deletedItemIds.includes(integration),
        )
      } else if (
        currentIntegrations &&
        typeof currentIntegrations === "object"
      ) {
        updatedIntegrations = JSON.parse(JSON.stringify(currentIntegrations))

        if (updatedIntegrations.knowledge_base?.itemIds) {
          const originalItemIds = [
            ...updatedIntegrations.knowledge_base.itemIds,
          ]
          updatedIntegrations.knowledge_base.itemIds =
            updatedIntegrations.knowledge_base.itemIds.filter(
              (id: string) => !deletedItemIds.includes(id),
            )
          loggerWithChild().info(
            `Agent ${agent.name}: original itemIds: ${JSON.stringify(originalItemIds)}, after filtering: ${JSON.stringify(updatedIntegrations.knowledge_base.itemIds)}`,
          )
          if (updatedIntegrations.knowledge_base.itemIds.length === 0) {
            delete updatedIntegrations.knowledge_base
            loggerWithChild().info(
              `Agent ${agent.name}: removed entire knowledge_base key as no itemIds left`,
            )
          }
        }
      } else {
        loggerWithChild().warn(
          `Unrecognized app_integrations format for agent ${agent.id}: ${JSON.stringify(currentIntegrations)}`,
        )
        continue
      }

      loggerWithChild().info(
        `Agent ${agent.name}: final updatedIntegrations: ${JSON.stringify(updatedIntegrations)}`,
      )

      console.log(
        "DEBUG: About to check update condition for agent:",
        agent.name,
      )

      const originalCount = Array.isArray(currentIntegrations)
        ? currentIntegrations.length
        : currentIntegrations?.knowledge_base?.itemIds?.length || 0
      const newCount = Array.isArray(updatedIntegrations)
        ? updatedIntegrations.length
        : updatedIntegrations?.knowledge_base?.itemIds?.length || 0

      const originalHasKnowledgeBase =
        currentIntegrations?.knowledge_base !== undefined
      const updatedHasKnowledgeBase =
        updatedIntegrations?.knowledge_base !== undefined
      const knowledgeBaseStructureChanged =
        originalHasKnowledgeBase !== updatedHasKnowledgeBase

      loggerWithChild().info(
        `Agent ${agent.name}: originalCount=${originalCount}, newCount=${newCount}, countChanged=${originalCount !== newCount}, knowledgeBaseStructureChanged=${knowledgeBaseStructureChanged}`,
      )

      const hasChanges =
        originalCount !== newCount ||
        knowledgeBaseStructureChanged ||
        JSON.stringify(currentIntegrations) !==
          JSON.stringify(updatedIntegrations)

      if (hasChanges) {
        loggerWithChild().info(
          `Agent ${agent.name}: updating database with new integrations`,
        )

        await trx
          .update(agents)
          .set({
            appIntegrations: updatedIntegrations,
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agent.id))

        updatedAgentsCount++
      } else {
        loggerWithChild().info(
          `Agent ${agent.name}: no changes needed, skipping update`,
        )
      }
    }
  } catch (error) {
    loggerWithChild().error(
      error,
      `Failed to clean up agents for deleted item IDs: ${deletedItemIds.join(", ")}`,
    )
    throw new Error(
      `Failed to clean up agents for deleted items: ${deletedItemIds.join(", ")}`,
    )
  }
}

// getAllPublicAgents removed — dead code that filtered on the dropped
// agents.is_public column (public agents now = a workspace acl grant).

// Collection IDs referenced by an agent's KB integrations. Accepts an external
// ID (permission-checked fetch; needs userId + userWorkspaceId) or an agent object.
export const getAgentCollectionIds = async (
  trx: TxnOrClient,
  agentInput: string | SelectAgent,
  userId?: number,
  userWorkspaceId?: number,
): Promise<string[]> => {
  let agent: SelectAgent

  if (typeof agentInput === "string") {
    if (!userId || !userWorkspaceId) {
      throw new Error("userId and userWorkspaceId are required when providing agentId")
    }
    const fetchedAgent = await getAgentByExternalIdWithPermissionCheck(
      trx,
      agentInput,
      userWorkspaceId,
      userId,
    )
    if (!fetchedAgent) {
      throw new Error("Agent cannot be accessed or does not exist")
    }
    agent = fetchedAgent
  } else {
    agent = agentInput
  }

  const appIntegrations = agent.appIntegrations as Record<string, any>
  const collectionIds: string[] = []

  if (
    appIntegrations &&
    typeof appIntegrations === "object" &&
    appIntegrations.knowledge_base
  ) {
    const clConfig = appIntegrations.knowledge_base
    const itemIds = clConfig.itemIds || []

    if (itemIds.length > 0) {
      // itemIds are prefixed: cl- = direct collection; clfd-/clf- = folder/file
      // whose owning collection must be looked up.
      const directCollectionIds: string[] = []
      const itemCollectionIds: string[] = []

      for (const itemId of itemIds) {
        if (itemId.startsWith("cl-")) {
          directCollectionIds.push(itemId.replace("cl-", ""))
        } else if (itemId.startsWith("clfd-") || itemId.startsWith("clf-")) {
          const actualItemId = itemId.replace(/^(clfd-|clf-)/, "")
          try {
            const item = await getCollectionItemById(trx, actualItemId)
            if (item && item.collectionId) {
              itemCollectionIds.push(item.collectionId)
            }
          } catch (error) {
            loggerWithChild().warn(
              `Failed to fetch KB item ${actualItemId} for collection ID extraction: ${error}`,
            )
          }
        }
      }

      const allCollectionIds = [...directCollectionIds, ...itemCollectionIds]
      collectionIds.push(...new Set(allCollectionIds))
    }
  }

  return collectionIds
}

// Like getAgentCollectionIds, but returns the resolved collection records.
export const getAgentCollections = async (
  trx: TxnOrClient,
  agentExternalId: string,
  userId: number,
  userWorkspaceId: number,
): Promise<any[]> => {
  const agent = await getAgentByExternalIdWithPermissionCheck(
    trx,
    agentExternalId,
    userWorkspaceId,
    userId,
  )

  if (!agent) {
    throw new Error("Agent cannot be accessed or does not exist")
  }

  const appIntegrations = agent.appIntegrations as Record<string, any>
  const collectionIds: string[] = []

  if (
    appIntegrations &&
    typeof appIntegrations === "object" &&
    appIntegrations.knowledge_base
  ) {
    const clConfig = appIntegrations.knowledge_base
    const itemIds = clConfig.itemIds || []

    if (itemIds.length > 0) {
      // itemIds are prefixed: cl- = direct collection; clfd-/clf- = folder/file
      // whose owning collection must be looked up.
      const directCollectionIds: string[] = []
      const itemCollectionIds: string[] = []

      for (const itemId of itemIds) {
        if (itemId.startsWith("cl-")) {
          directCollectionIds.push(itemId.replace("cl-", ""))
        } else if (itemId.startsWith("clfd-") || itemId.startsWith("clf-")) {
          const actualItemId = itemId.replace(/^(clfd-|clf-)/, "")
          try {
            const item = await getCollectionItemById(trx, actualItemId)
            if (item && item.collectionId) {
              itemCollectionIds.push(item.collectionId)
            }
          } catch (error) {
            loggerWithChild().warn(
              `Failed to fetch KB item ${actualItemId} for collection ID extraction: ${error}`,
            )
          }
        }
      }

      const allCollectionIds = [...directCollectionIds, ...itemCollectionIds]
      collectionIds.push(...new Set(allCollectionIds))
    }
  }

  const collections = []
  for (const collectionId of collectionIds) {
    try {
      const collection = await getCollectionById(trx, collectionId)
      if (collection) {
        collections.push(collection)
      }
    } catch (error) {
      loggerWithChild().warn(
        `Failed to fetch collection ${collectionId}: ${error}`,
      )
    }
  }

  return collections
}

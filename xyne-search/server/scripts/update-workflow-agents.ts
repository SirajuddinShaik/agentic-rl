import { db } from "@/platform/db/client"
import { agents } from "@/platform/db/schema"
import { and, eq, isNull, sql } from "drizzle-orm"
import { AgentCreationSource } from "@/platform/db/schema"
import { countWorkflowAgents } from "./count-workflow-agents"

export const updateWorkflowAgents = async () => {
      console.log("🔄 Updating workflow agents from DIRECT to WORKFLOW...")

      const existingCount = await countWorkflowAgents()
      if (existingCount === 0) {
          console.log("✅ No workflow agents to update.")
          return
      }

      const result = await db
          .update(agents)
          .set({
              creation_source: AgentCreationSource.WORKFLOW,
              updatedAt: new Date()
          })
          .where(
              and(
                  eq(agents.creation_source, AgentCreationSource.DIRECT),
                  sql`is_public = false`,
                  eq(agents.appIntegrations, sql`'[]'::jsonb`),
                  eq(agents.allowWebSearch, false),
                  eq(agents.isRagOn, false),
                  eq(agents.docIds, sql`'[]'::jsonb`),
                  isNull(agents.deletedAt)
              )
          )

      console.log(`✅ Updated agents ${existingCount} from DIRECT to WORKFLOW`)
      return result
  }


// Run if this file is executed directly
if (require.main === module) {
    updateWorkflowAgents()
        .then(() => {
            console.log("🎉 successfully updated workflow agents")
            process.exit(0)
        })
        .catch((error) => {
            console.error("💥 Script failed:", error)
            process.exit(1)
        })
}

import { agentDeps } from "./wiring"
import { ChatService } from "./services/chat"

export const chatService = new ChatService(agentDeps())

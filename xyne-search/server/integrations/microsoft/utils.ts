import { getLogger, getLoggerWithChild } from "@/platform/logger"
import { Subsystem } from "@/types"
import type { MicrosoftGraphClient } from "./client"
import { downloadFileFromGraph, makeGraphApiCall } from "./client"
import { Apps, DriveEntity } from "@/platform/shared/types"
import { chunkDocument } from "@/ingestion/chunking/chunks"
import { MAX_ONEDRIVE_FILE_SIZE } from "./config"
import type {
  AuthenticationProvider,
} from "@microsoft/microsoft-graph-client"
import { ClientSecretCredential, type AccessToken } from "@azure/identity"
import type { Permission, DriveItem } from "@microsoft/microsoft-graph-types"
import { extractTextAndImagesWithChunksFromDocx } from "@/ingestion/chunking/docxChunks"
import { hashPdfFilename } from "@/utils"
import type { VespaFileWithDrivePermission } from "@xyne/vespa-ts/types"
import fs from "node:fs"
import path from "node:path"
import { unlink } from "node:fs/promises"
import type { Document } from "@langchain/core/documents"
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf"

export const loggerWithChild = getLoggerWithChild(Subsystem.Integrations, {
  module: "microsoft",
})

const Logger = getLogger(Subsystem.Integrations).child({ module: "microsoft" })

export const downloadDir = path.resolve(__dirname, "../../downloads")

if (process.env.NODE_ENV !== "production") {
  const init = () => {
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true })
    }
  }
  init()
}

export const deleteDocument = async (filePath: string) => {
  try {
    await unlink(filePath)
    Logger.debug(`File at ${filePath} deleted successfully`)
  } catch (err) {
    Logger.error(
      err,
      `Error deleting file at ${filePath}: ${err} ${(err as Error).stack}`,
      err,
    )
    throw new Error(`Error deleting file: ${(err as Error).message}`)
  }
}

export async function safeLoadPDF(pdfPath: string): Promise<Document[]> {
  try {
    const loader = new PDFLoader(pdfPath)
    return await loader.load()
  } catch (error) {
    const { name, message } = error as Error
    if (
      message.includes("PasswordException") ||
      name.includes("PasswordException")
    ) {
      Logger.warn("Password protected PDF, skipping")
    } else {
      Logger.error(error, `PDF load error: ${error}`)
    }
    return []
  }
}
export const MicrosoftMimeType = {
  WordDocumentModern:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ExcelSpreadsheetModern:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  PowerPointPresentationModern:
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  PDF: "application/pdf",
  PlainText: "text/plain",
  JPEG: "image/jpeg",
  PNG: "image/png",
  Zip: "application/zip",
  WordDocumentLegacy: "application/msword",
  ExcelSpreadsheetLegacy: "application/vnd.ms-excel",
  PowerPointPresentationLegacy: "application/vnd.ms-powerpoint",
  CSV: "text/csv",
} as const
export type MicrosoftMimeType =
  (typeof MicrosoftMimeType)[keyof typeof MicrosoftMimeType]

// MIME types that support content extraction
export const MimeMapForContent: Record<string, boolean> = {
  [MicrosoftMimeType.PDF]: true,
  [MicrosoftMimeType.PlainText]: true,
  [MicrosoftMimeType.CSV]: true,
  [MicrosoftMimeType.WordDocumentModern]: true,
  [MicrosoftMimeType.ExcelSpreadsheetModern]: true,
  [MicrosoftMimeType.PowerPointPresentationModern]: true,
  [MicrosoftMimeType.WordDocumentLegacy]: true,
  [MicrosoftMimeType.ExcelSpreadsheetLegacy]: true,
  [MicrosoftMimeType.PowerPointPresentationLegacy]: true,
}

// Custom authentication provider for Microsoft Graph using ClientSecretCredential
export class CustomServiceAuthProvider implements AuthenticationProvider {
  private credential: ClientSecretCredential

  constructor(tenantId: string, clientId: string, clientSecret: string) {
    this.credential = new ClientSecretCredential(
      tenantId,
      clientId,
      clientSecret,
    )
  }

  async getAccessToken(): Promise<string> {
    const tokenResponse = await this.credential.getToken(
      "https://graph.microsoft.com/.default",
    )
    if (!tokenResponse) {
      throw new Error("Failed to get access token")
    }
    return tokenResponse.token
  }

  async getAccessTokenWithExpiry(): Promise<AccessToken> {
    const tokenResponse = await this.credential.getToken(
      "https://graph.microsoft.com/.default",
    )
    if (!tokenResponse) {
      throw new Error("Failed to get access token")
    }
    return tokenResponse
  }
}

export const getOneDriveFile = async (
  graphClient: MicrosoftGraphClient,
  fileId: string,
): Promise<any | null> => {
  try {
    const file = await makeGraphApiCall(
      graphClient,
      `/me/drive/items/${fileId}`,
    )
    return file
  } catch (error) {
    Logger.error(error, `Error fetching OneDrive file ${fileId}: ${error}`)
    return null
  }
}

export const getOneDriveFileContent = async (
  graphClient: MicrosoftGraphClient,
  fileId: string,
  fileName: string,
  mimeType: string,
): Promise<string[]> => {
  try {
    if (!MimeMapForContent[mimeType]) {
      Logger.debug(`File type ${mimeType} not supported for content extraction`)
      return []
    }

    const contentResponse = await graphClient.client
      .api(`/me/drive/items/${fileId}/content`)
      .header("Accept", "text/plain")
      .get()

    if (typeof contentResponse === "string") {
      const chunks = chunkDocument(contentResponse)
      return chunks.map((chunk) => chunk.chunk)
    }

    Logger.warn(`Could not extract text content from ${fileName}`)
    return []
  } catch (error) {
    Logger.error(
      error,
      `Error extracting content from OneDrive file ${fileId}: ${error}`,
    )
    return []
  }
}
export const toOneDrivePermissionsList = (
  permissions: any[] | undefined,
  ownerEmail: string,
): string[] => {
  if (!permissions || permissions.length === 0) {
    return [ownerEmail]
  }

  const emailList = permissions
    .filter((p) => p.grantedToV2?.user?.email || p.grantedTo?.user?.email)
    .map((p) => p.grantedToV2?.user?.email || p.grantedTo?.user?.email)
    .filter(Boolean)

  if (!emailList.includes(ownerEmail)) {
    emailList.push(ownerEmail)
  }

  return emailList
}

export const isFileTooLarge = (fileSize: number | undefined): boolean => {
  if (!fileSize) return false
  const fileSizeInMB = fileSize / (1024 * 1024)
  return fileSizeInMB > MAX_ONEDRIVE_FILE_SIZE
}

export const getEntityFromMimeType = (
  mimeType: string | undefined,
): DriveEntity => {
  if (!mimeType) return DriveEntity.Misc

  return microsoftMimeTypeMap[mimeType] ?? DriveEntity.Misc
}

export const formatOneDriveMetadata = (file: any): string => {
  return JSON.stringify({
    parentPath: file.parentReference?.path ?? "",
    parentName: file.parentReference?.name ?? "",
    size: file.size ?? 0,
    webUrl: file.webUrl ?? "",
    downloadUrl: file["@microsoft.graph.downloadUrl"] ?? "",
    lastModifiedBy: file.lastModifiedBy?.user?.displayName ?? "",
    createdBy: file.createdBy?.user?.displayName ?? "",
  })
}

export const extractDeltaToken = (deltaLink: string): string | null => {
  try {
    const url = new URL(deltaLink)
    return (
      url.searchParams.get("token") ||
      url.searchParams.get("$deltatoken") ||
      url.searchParams.get("$skiptoken")
    )
  } catch (error) {
    Logger.error(error, `Error extracting delta token from ${deltaLink}`)
    return null
  }
}

export const shouldProcessChange = (change: any): boolean => {
  // Process deletions so they can be removed from Vespa
  if (change.deleted) {
    return true
  }

  if (change.folder) {
    return false
  }

  if (!change.file) {
    return false
  }

  if (isFileTooLarge(change.size)) {
    Logger.warn(
      `Skipping file ${change.name} as it's larger than ${MAX_ONEDRIVE_FILE_SIZE}MB`,
    )
    return false
  }

  return true
}

export async function getFilePermissionsSharepoint(
  client: MicrosoftGraphClient,
  fileId: string,
  driveId: string,
): Promise<string[]> {
  const endpoint = `drives/${driveId}/items/${fileId}/permissions`

  try {
    const response = await makeGraphApiCall(client, endpoint)
    const permissions: string[] = []

    if (response.value && Array.isArray(response.value)) {
      const permissionsList = response.value as Permission[]
      for (const permission of permissionsList) {
        if (permission.grantedToV2?.siteUser?.loginName) {
          const loginName = permission.grantedToV2.siteUser.loginName
          // loginName format: "i:0#.f|membership|email@domain.com"
          const emailMatch = loginName.match(/\|([^|]+@[^|]+)$/)
          if (emailMatch && emailMatch[1]) {
            permissions.push(emailMatch[1])
          }
        }
      }
    }

    return Array.from(new Set(permissions))
  } catch (error) {
    loggerWithChild({ email: "system" }).error(
      error,
      `Error fetching SharePoint file permissions for ${fileId}: ${(error as Error).message}`,
    )
    return []
  }
}

//Get permissions for a file in one-drive or sharepoint
export async function getFilePermissions(
  client: MicrosoftGraphClient,
  fileId: string,
): Promise<string[]> {
  try {
    const endpoint = `me/drive/items/${fileId}/permissions`

    const response = await makeGraphApiCall(client, endpoint)

    const emails = new Set<string>()

    if (response.value && Array.isArray(response.value)) {
      for (const permission of response.value) {
        // Skip link-only permissions (no user identities)
        if (
          permission.link &&
          !permission.grantedToV2 &&
          !permission.grantedToIdentitiesV2
        ) {
          continue
        }

        // grantedToV2 / grantedToIdentitiesV2 are modern; grantedTo / grantedToIdentities are legacy
        if (permission.grantedToV2?.siteUser?.email) {
          emails.add(permission.grantedToV2.siteUser.email)
        } else if (permission.grantedToV2?.user?.email) {
          emails.add(permission.grantedToV2.user.email)
        } else if (permission.grantedToV2?.user?.userPrincipalName) {
          emails.add(permission.grantedToV2.user.userPrincipalName)
        }

        if (Array.isArray(permission.grantedToIdentitiesV2)) {
          for (const identity of permission.grantedToIdentitiesV2) {
            if (identity.siteUser?.email) {
              emails.add(identity.siteUser.email)
            } else if (identity.user?.email) {
              emails.add(identity.user.email)
            } else if (identity.user?.userPrincipalName) {
              emails.add(identity.user.userPrincipalName)
            }
          }
        }

        if (permission.grantedTo?.user?.email) {
          emails.add(permission.grantedTo.user.email)
        } else if (permission.grantedTo?.user?.userPrincipalName) {
          emails.add(permission.grantedTo.user.userPrincipalName)
        }

        if (Array.isArray(permission.grantedToIdentities)) {
          for (const identity of permission.grantedToIdentities) {
            if (identity.user?.email) {
              emails.add(identity.user.email)
            } else if (identity.user?.userPrincipalName) {
              emails.add(identity.user.userPrincipalName)
            }
          }
        }
      }
    }

    return [...emails]
  } catch (error) {
    Logger.warn(
      `Failed to get permissions for file ${fileId}: ${(error as Error).message}`,
    )
    return []
  }
}

// Mirrors googlePDFsVespa
async function processMicrosoftPDFs(
  graphClient: MicrosoftGraphClient,
  pdfFiles: DriveItem[],
  userEmail: string,
): Promise<VespaFileWithDrivePermission[]> {
  const results: VespaFileWithDrivePermission[] = []

  for (const file of pdfFiles) {
    try {
      const pdfBuffer = await downloadFileFromGraph(
        graphClient,
        file.id!,
        file.parentReference?.driveId!,
      )

      const pdfFileName = `${hashPdfFilename(`${userEmail}_${file.id}_${file.name}`)}.pdf`
      const pdfPath = `${downloadDir}/${pdfFileName}`

      await fs.promises.writeFile(pdfPath, new Uint8Array(pdfBuffer))

      const docs = await safeLoadPDF(pdfPath)
      if (!docs || docs.length === 0) {
        await deleteDocument(pdfPath)
        continue
      }

      const chunks = docs.flatMap((doc: Document) =>
        chunkDocument(doc.pageContent),
      )

      await deleteDocument(pdfPath)

      results.push({
        title: file.name!,
        url: file.webUrl ?? "",
        app: Apps.MicrosoftDrive,
        docId: file.id!,
        parentId: file.parentReference?.id ?? null,
        owner: "",
        photoLink: "",
        ownerEmail: userEmail,
        entity: DriveEntity.PDF,
        chunks: chunks.map((c: any) => c.chunk),
        permissions: [],
        mimeType: file.file?.mimeType ?? "",
        metadata: JSON.stringify({
          parentPath: file.parentReference?.path,
          size: file.size,
        }),
        createdAt: new Date(file.createdDateTime!).getTime(),
        updatedAt: new Date(file.lastModifiedDateTime!).getTime(),
      })
    } catch (error) {
      console.error(`Error processing PDF ${file.name}:`, error)
      continue
    }
  }

  return results
}

async function processMicrosoftWord(
  graphClient: MicrosoftGraphClient,
  wordFiles: DriveItem[],
  userEmail: string,
): Promise<VespaFileWithDrivePermission[]> {
  const results: VespaFileWithDrivePermission[] = []

  for (const file of wordFiles) {
    try {
      const docxBuffer = await downloadFileFromGraph(
        graphClient,
        file.id!,
        file.parentReference?.driveId!,
      )

      const extractedContent =
        await extractTextAndImagesWithChunksFromDocx(docxBuffer)

      results.push({
        title: file.name!,
        url: file.webUrl ?? "",
        // refreshToken present => personal OneDrive; absent => SharePoint app-only
        app: graphClient.refreshToken
          ? Apps.MicrosoftDrive
          : Apps.MicrosoftSharepoint,
        docId: file.id!,
        parentId: file.parentReference?.id ?? null,
        owner: "",
        photoLink: "",
        ownerEmail: userEmail,
        entity: DriveEntity.WordDocument,
        chunks: extractedContent.text_chunks || [],
        permissions: [],
        mimeType: file.file?.mimeType ?? "",
        metadata: JSON.stringify({
          parentPath: file.parentReference?.path,
          size: file.size,
          images: extractedContent.image_chunks?.length || 0,
        }),
        createdAt: new Date(file.createdDateTime!).getTime(),
        updatedAt: new Date(file.lastModifiedDateTime!).getTime(),
      })
    } catch (error) {
      console.error(`Error processing Word document ${file.name}:`, error)
      continue
    }
  }

  return results
}

// TODO: Excel processing fails for huge files (Graph response limit)
export async function processFileContent(
  graphClient: MicrosoftGraphClient,
  file: DriveItem,
  userEmail: string,
): Promise<string[]> {
  const mimeType = file.file?.mimeType

  try {
    switch (mimeType) {
      case "application/pdf":
        const pdfResults = await processMicrosoftPDFs(
          graphClient,
          [file],
          userEmail,
        )
        return pdfResults[0]?.chunks || []

      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        const wordResults = await processMicrosoftWord(
          graphClient,
          [file],
          userEmail,
        )
        return wordResults[0]?.chunks || []

      case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        // TODO: processMicrosoftExcel disabled (Graph response limit on huge files)
        return []

      default:
        // Unsupported type: metadata only
        return []
    }
  } catch (error) {
    console.error(`Error processing file content for ${file.name}:`, error)
    return []
  }
}

export const logSyncProgress = (
  operation: string,
  fileId: string,
  fileName: string,
  details?: any,
) => {
  Logger.info(`OneDrive Sync - ${operation}`, {
    fileId,
    fileName,
    ...details,
  })
}

export const createInitialDeltaConfig = () => {
  return {
    type: "microsoftDriveDeltaToken" as const,
    driveToken: "",
    contactsToken: "",
    lastSyncedAt: new Date(),
  }
}

export interface OneDriveFile {
  id: string
  name: string
  webUrl?: string
  createdDateTime: string
  lastModifiedDateTime: string
  size?: number
  file?: {
    mimeType?: string
  }
  folder?: any
  deleted?: {
    state: string
  }
  createdBy?: {
    user?: {
      displayName?: string
      email?: string
    }
  }
  lastModifiedBy?: {
    user?: {
      displayName?: string
      email?: string
    }
  }
  parentReference?: {
    id?: string
    name?: string
    path?: string
  }
}

export const microsoftMimeTypeMap: Record<string, DriveEntity> = {
  [MicrosoftMimeType.WordDocumentModern]: DriveEntity.WordDocument,
  [MicrosoftMimeType.ExcelSpreadsheetModern]: DriveEntity.ExcelSpreadsheet,
  [MicrosoftMimeType.PowerPointPresentationModern]:
    DriveEntity.PowerPointPresentation,
  [MicrosoftMimeType.PDF]: DriveEntity.PDF,
  [MicrosoftMimeType.PlainText]: DriveEntity.Text,
  [MicrosoftMimeType.JPEG]: DriveEntity.Image,
  [MicrosoftMimeType.PNG]: DriveEntity.Image,
  [MicrosoftMimeType.Zip]: DriveEntity.Zip,
  [MicrosoftMimeType.WordDocumentLegacy]: DriveEntity.WordDocument,
  [MicrosoftMimeType.ExcelSpreadsheetLegacy]: DriveEntity.ExcelSpreadsheet,
  [MicrosoftMimeType.PowerPointPresentationLegacy]:
    DriveEntity.PowerPointPresentation,
  [MicrosoftMimeType.CSV]: DriveEntity.CSV,
}

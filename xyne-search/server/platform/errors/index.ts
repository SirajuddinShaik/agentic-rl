import type { Apps } from "@/platform/shared/types"

// TODO: add more default error messages

const DbOp = {
  Create: "Create",
  READ: "Read",
  Update: "Update",
  Delete: "Delete",
} as const
type DbOp = (typeof DbOp)[keyof typeof DbOp]

const Model = {
  Connectors: "connectors",
  Providers: "providers",
  Users: "users",
} as const
type Model = (typeof Model)[keyof typeof Model]

type BaseErrorOpts = {
  message?: string | undefined
  cause?: Error | undefined
  fn?: any
}

type ErrorOpts = {
  cause?: Error
  fn?: Function
}

type DbErrorOpts = BaseErrorOpts & {
  model: Model
  dbOp: DbOp
}

class DbError extends Error {
  constructor({ message, model, dbOp, cause }: DbErrorOpts) {
    super(`${message}: for model ${model} and op: ${dbOp}`, { cause })
    Error.captureStackTrace(this, this.constructor)
  }
}

const VespaDbOp = {
  Search: "Search",
} as const
type VespaDbOp = (typeof VespaDbOp)[keyof typeof VespaDbOp]

type Op = VespaDbOp | DbOp

type VespaErrorOpts = BaseErrorOpts & {
  sources: string
  op: Op
  docId?: string
}

type VespaErrorOptsSansOp = Omit<VespaErrorOpts, "op">

class VespaError extends Error {
  constructor({ message, sources, op, docId, cause }: VespaErrorOpts) {
    let fullMessage = `${message}: for source ${sources} and op: ${op}`
    if (docId) fullMessage += ` for docId: ${docId}`
    super(fullMessage, { cause })
    Error.captureStackTrace(this, this.constructor)
  }
}

const IntegrationOp = {} as const
type IntegrationOp = (typeof IntegrationOp)[keyof typeof IntegrationOp]

type IntegrationErrorOpts = BaseErrorOpts & {
  integration: Apps
  entity: any
  op?: IntegrationOp
  docId?: string
  jobId?: string
}

type IntegrationErrorPartialMsgOpts = Omit<IntegrationErrorOpts, "message"> &
  Partial<Pick<IntegrationErrorOpts, "message">> &
  ErrorOpts

class IntegrationsError extends Error {
  constructor({
    message,
    integration,
    entity,
    op,
    docId,
    jobId,
    cause,
  }: IntegrationErrorOpts) {
    let fullMessage = `${message}: for integration ${integration} ${entity} and op: ${op}`
    if (docId) fullMessage += ` for docId: ${docId}`
    if (jobId) fullMessage += ` and jobId: ${jobId}`
    super(fullMessage, { cause })
    Error.captureStackTrace(this, this.constructor)
  }
}

export class InitialisationError extends Error {
  constructor(errOpts: errorOpts) {
    let { message, cause } = errOpts
    if (!message) {
      message = "Error while initialising the server"
    }
    super(message, { cause })
    this.name = this.constructor.name
  }
}

type errorOpts = { message?: string; cause?: Error }
export class AuthRedirectError extends Error {
  constructor(errOpts: errorOpts) {
    let { message, cause } = errOpts
    if (!message) {
      message = "Error while auth redirection"
    }
    super(message, { cause })
    this.name = this.constructor.name
  }
}

export class ErrorUpdatingDocument extends VespaError {
  constructor(vespaErrOpts: VespaErrorOptsSansOp) {
    super({ ...vespaErrOpts, op: DbOp.Update })
    this.name = this.constructor.name
  }
}

export class ErrorPerformingSearch extends VespaError {
  constructor(vespaErrOpts: VespaErrorOptsSansOp) {
    super({ ...vespaErrOpts, op: VespaDbOp.Search })
    this.name = this.constructor.name
  }
}

export class ErrorGettingDocument extends VespaError {
  constructor(vespaErrOpts: VespaErrorOptsSansOp) {
    super({ ...vespaErrOpts, op: DbOp.READ })
    this.name = this.constructor.name
  }
}

export class ErrorDeletingDocuments extends VespaError {
  constructor(errorOpts: VespaErrorOptsSansOp) {
    super({ ...errorOpts, op: DbOp.READ })
    this.name = this.constructor.name
  }
}

export class ErrorInsertingDocument extends VespaError {
  constructor(vespaErrOpts: VespaErrorOptsSansOp) {
    let { message, cause } = vespaErrOpts
    if (!message) {
      message = `Error inserting document`
    }
    super({ ...vespaErrOpts, message, cause, op: DbOp.Create })
    this.name = this.constructor.name
  }
}

export class ErrorRetrievingDocuments extends VespaError {
  constructor(vespaErrOpts: VespaErrorOptsSansOp) {
    let { message, cause } = vespaErrOpts
    if (!message) {
      message = "Error retrieving documents"
    }
    super({ ...vespaErrOpts, message, cause, op: DbOp.READ })
    this.name = this.constructor.name
  }
}

export class MissingDocumentWithId extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = `Could not get document`
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}

export class CouldNotFinishJobSuccessfully extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = "Could not finish job successfully"
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}

export class UserListingError extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = `Error listing users`
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}

export class ContactListingError extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = `Could not list contact`
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}

export class ContactMappingError extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = `Could not map contact to vespa schema`
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}

export class SyncJobFailed extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = `Could not successfully complete sync job`
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}

export class EmailParsingError extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = `Could not parse email`
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}

export class MissingOauthConnectorCredentialsError extends DbError {
  constructor(errOpts: BaseErrorOpts) {
    let { message } = errOpts
    if (!message) {
      message = `Severe: OAuth connector credentials are not present`
    }
    super({ message, model: Model.Connectors, dbOp: DbOp.READ })
    this.name = this.constructor.name
  }
}

export class UpdateConnectorFailed extends DbError {
  constructor(message: string) {
    super({ message, model: Model.Connectors, dbOp: DbOp.Update })
    this.name = this.constructor.name
  }
}

export class FetchProviderFailed extends DbError {
  constructor({ message, cause }: BaseErrorOpts) {
    super({ message, model: Model.Providers, dbOp: DbOp.Update, cause })
    this.name = this.constructor.name
  }
}

export class NoOauthConnectorFound extends DbError {
  constructor({ message, cause }: BaseErrorOpts) {
    super({ message, model: Model.Connectors, dbOp: DbOp.Create, cause })
    this.name = this.constructor.name
  }
}

export class NoConnectorsFound extends DbError {
  constructor({ message, cause }: BaseErrorOpts) {
    super({ message, model: Model.Connectors, dbOp: DbOp.READ, cause })
    this.name = this.constructor.name
  }
}

export class ConnectionInsertionError extends DbError {
  constructor({ message, cause }: BaseErrorOpts) {
    super({ message, model: Model.Connectors, dbOp: DbOp.Create, cause })
    this.name = this.constructor.name
  }
}

export class OAuthCallbackError extends Error {
  constructor({ message, cause }: BaseErrorOpts) {
    super(`${message || "Error while executing oauth callback"}`, { cause })
    this.name = this.constructor.name
  }
}

export class NoUserFound extends DbError {
  constructor({ message, cause }: BaseErrorOpts) {
    super({ message, model: Model.Users, dbOp: DbOp.READ, cause })
    this.name = "NoUserFound"
  }
}

export class AddServiceConnectionError extends DbError {
  constructor({ message, cause }: BaseErrorOpts) {
    super({ message, model: Model.Connectors, dbOp: DbOp.Create, cause })
    this.name = this.constructor.name
  }
}

export class ConnectorNotCreated extends DbError {
  constructor({ message, cause }: BaseErrorOpts) {
    super({ message, model: Model.Connectors, dbOp: DbOp.READ, cause })
    this.name = this.constructor.name
  }
}

export class DownloadDocumentError extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = `Error while downloading document`
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}

export class DeleteDocumentError extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = `Error while deleting document`
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}

export class CalendarEventsListingError extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = `Could not list calendar events`
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}

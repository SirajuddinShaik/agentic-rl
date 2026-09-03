import { customType } from "drizzle-orm/pg-core"
import { Encryption } from "@/utils/encryption"

// Symmetric encrypt-on-write / decrypt-on-read text column; encrypted form is stored as text.
export const encryptedText = (encryption: Encryption) => {
  return customType<{ data: string | null; notNull: false }>({
    dataType() {
      return "text"
    },
    fromDriver(value: unknown): string | null {
      if (!value) {
        return value as null
      }
      return encryption.decrypt(value as string)
    },
    toDriver(value: string | null): string | null {
      if (!value) {
        return value
      }
      return encryption.encrypt(value)
    },
  })
}
export const oneWayEncryption = (encryption: Encryption) => {
  return customType<{ data: string | null; notNull: false }>({
    dataType() {
      return "text"
    },
    /**
     * Values from database are already hashed - return as-is
     */
    fromDriver(value: unknown): string | null {
      return value as string | null
    },
    /**
     * Hash the value before storing in database
     */
    toDriver(value: string | null): string | null {
      if (!value) {
        return value
      }
      // Use the most secure hashing method
      return encryption.hashOneWayScrypt(value)
    },
  })
}
/**
 * Custom type for binary data (bytea) using Buffer.
 * This is a simple passthrough type for binary data.
 */
export const bytea = customType<{
  data: Buffer
  driverData: Buffer
}>({
  dataType() {
    return "bytea"
  },
  toDriver(value: Buffer): Buffer {
    return value
  },
  fromDriver(value: Buffer): Buffer {
    return value
  },
})

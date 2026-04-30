import CryptoKit
import Foundation
import Security

private let keychainService = "com.evalops.maestro.device-identity"
private let keychainAccount = "secure-enclave-p256-signing-key-v1"

struct Request: Decodable {
    let command: String
    let challenge: String?
}

struct Response: Encodable {
    let available: Bool
    let device_id: String?
    let key_algorithm: String?
    let key_origin: String?
    let public_key_spki: String?
    let signature: String?
    let error: String?
}

enum DeviceIdentityError: Error, CustomStringConvertible {
    case invalidCommand
    case missingChallenge
    case secureEnclaveUnavailable
    case keychain(OSStatus)
    case invalidStoredKey
    case accessControlCreationFailed(String)

    var description: String {
        switch self {
        case .invalidCommand:
            return "invalid_command"
        case .missingChallenge:
            return "missing_challenge"
        case .secureEnclaveUnavailable:
            return "secure_enclave_unavailable"
        case .keychain(let status):
            return "keychain_error_\(status)"
        case .invalidStoredKey:
            return "invalid_stored_key"
        case .accessControlCreationFailed(let message):
            return "access_control_creation_failed_\(message)"
        }
    }
}

func base64URL(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

func keychainQuery() -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: keychainService,
        kSecAttrAccount as String: keychainAccount
    ]
}

func loadStoredKeyData() throws -> Data? {
    var query = keychainQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound {
        return nil
    }
    guard status == errSecSuccess else {
        throw DeviceIdentityError.keychain(status)
    }
    guard let data = item as? Data else {
        throw DeviceIdentityError.invalidStoredKey
    }
    return data
}

func storeKeyData(_ data: Data) throws {
    var attributes = keychainQuery()
    attributes[kSecValueData as String] = data
    attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    let status = SecItemAdd(attributes as CFDictionary, nil)
    if status == errSecDuplicateItem {
        let updateStatus = SecItemUpdate(keychainQuery() as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard updateStatus == errSecSuccess else {
            throw DeviceIdentityError.keychain(updateStatus)
        }
        return
    }
    guard status == errSecSuccess else {
        throw DeviceIdentityError.keychain(status)
    }
}

func loadOrCreateKey() throws -> SecureEnclave.P256.Signing.PrivateKey {
    guard SecureEnclave.isAvailable else {
        throw DeviceIdentityError.secureEnclaveUnavailable
    }
    if let stored = try loadStoredKeyData() {
        return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: stored)
    }
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        [.privateKeyUsage],
        &error
    ) else {
        let message = error?.takeRetainedValue().localizedDescription ?? "unknown"
        throw DeviceIdentityError.accessControlCreationFailed(message)
    }
    let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
    try storeKeyData(key.dataRepresentation)
    return key
}

func statusResponse() -> Response {
    do {
        let key = try loadOrCreateKey()
        let publicKey = key.publicKey.derRepresentation
        let digest = SHA256.hash(data: publicKey)
        return Response(
            available: true,
            device_id: "dev_\(base64URL(Data(digest)))",
            key_algorithm: "p256_ecdsa_sha256",
            key_origin: "secure_enclave",
            public_key_spki: base64URL(publicKey),
            signature: nil,
            error: nil
        )
    } catch {
        return Response(
            available: false,
            device_id: nil,
            key_algorithm: "p256_ecdsa_sha256",
            key_origin: "secure_enclave",
            public_key_spki: nil,
            signature: nil,
            error: String(describing: error)
        )
    }
}

func signResponse(challenge: String?) throws -> Response {
    guard let challenge, !challenge.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw DeviceIdentityError.missingChallenge
    }
    let key = try loadOrCreateKey()
    let publicKey = key.publicKey.derRepresentation
    let digest = SHA256.hash(data: publicKey)
    let signature = try key.signature(for: Data(challenge.utf8))
    return Response(
        available: true,
        device_id: "dev_\(base64URL(Data(digest)))",
        key_algorithm: "p256_ecdsa_sha256",
        key_origin: "secure_enclave",
        public_key_spki: base64URL(publicKey),
        signature: base64URL(signature.derRepresentation),
        error: nil
    )
}

func readRequest() throws -> Request {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    return try JSONDecoder().decode(Request.self, from: data)
}

func writeResponse(_ response: Response) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = (try? encoder.encode(response)) ?? Data("{\"available\":false,\"error\":\"encode_response_failed\"}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

do {
    let request = try readRequest()
    switch request.command {
    case "status", "publicKey":
        writeResponse(statusResponse())
    case "sign":
        writeResponse(try signResponse(challenge: request.challenge))
    default:
        throw DeviceIdentityError.invalidCommand
    }
} catch {
    writeResponse(Response(
        available: false,
        device_id: nil,
        key_algorithm: "p256_ecdsa_sha256",
        key_origin: "secure_enclave",
        public_key_spki: nil,
        signature: nil,
        error: String(describing: error)
    ))
    exit(1)
}

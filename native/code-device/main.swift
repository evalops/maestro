import Foundation
import DeviceCheck
import CryptoKit

// The key remains in App Attest's hardware-backed store. Only its identifier
// and Apple's attestation/assertion objects cross the native process boundary.
@main
struct CodeDevice {
    static func main() async {
        do {
            var input = Data()
            while input.count <= 65536 {
                guard let chunk = try FileHandle.standardInput.read(upToCount: 65537 - input.count), !chunk.isEmpty else { break }
                input.append(chunk)
            }
            guard input.count <= 65536,
                  let request = try JSONSerialization.jsonObject(with: input) as? [String: String],
                  let command = request["command"] else { throw Failure.invalidRequest }
            let service = DCAppAttestService.shared
            guard service.isSupported else { throw Failure.unsupported }
            let result: [String: String]
            switch command {
            case "generate":
                result = ["keyId": try await service.generateKey()]
            case "attest", "assert":
                guard let key = request["keyId"], !key.isEmpty,
                      let client = request["clientData"], !client.isEmpty else { throw Failure.invalidRequest }
                let digest = Data(SHA256.hash(data: Data(client.utf8)))
                let proof = command == "attest"
                    ? try await service.attestKey(key, clientDataHash: digest)
                    : try await service.generateAssertion(key, clientDataHash: digest)
                result = ["proof": proof.base64EncodedString()]
            default:
                throw Failure.invalidRequest
            }
            FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
        } catch {
            // Do not print challenge material, key handles, proofs, or platform
            // diagnostics that may contain enrollment data.
            let category: String
            if case Failure.unsupported = error { category = "unsupported_hardware" }
            else if case Failure.invalidRequest = error { category = "invalid_request" }
            else { category = "platform_error_\((error as NSError).code)" }
            FileHandle.standardError.write(Data("Code device attestation unavailable: \(category)\n".utf8))
            exit(1)
        }
    }
    enum Failure: Error { case invalidRequest, unsupported }
}

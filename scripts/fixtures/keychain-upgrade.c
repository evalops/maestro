// Disposable legacy-Keychain probe. Maestro's apple-native-keyring-store uses
// these same generic-password APIs. Never searches or changes the login keychain.
#include <Security/Security.h>
#include <stdio.h>
#include <string.h>

#ifndef BUILD_VERSION
#define BUILD_VERSION "1"
#endif

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    OSStatus status = SecKeychainSetUserInteractionAllowed(false);
    if (status != errSecSuccess) return 3;
    SecKeychainRef keychain = NULL;
    const char *service = "maestro-packaging-upgrade-test";
    const char *account = "disposable";
    const char *secret = "non-secret-fixture";
    if (strcmp(argv[1], "create") == 0) {
        status = SecKeychainCreate(argv[2], 7, "fixture", false, NULL, &keychain);
        if (status == errSecSuccess) {
            status = SecKeychainAddGenericPassword(keychain, (UInt32)strlen(service), service,
                (UInt32)strlen(account), account, (UInt32)strlen(secret), secret, NULL);
        }
    } else {
        status = SecKeychainOpen(argv[2], &keychain);
        if (status == errSecSuccess && strcmp(argv[1], "delete") == 0) {
            status = SecKeychainDelete(keychain);
        } else if (status == errSecSuccess && strcmp(argv[1], "read") == 0) {
            UInt32 length = 0;
            void *data = NULL;
            status = SecKeychainFindGenericPassword(keychain, (UInt32)strlen(service), service,
                (UInt32)strlen(account), account, &length, &data, NULL);
            if (status == errSecSuccess) {
                if (length != strlen(secret) || memcmp(data, secret, length) != 0) status = -1;
                SecKeychainItemFreeContent(NULL, data);
            }
        } else if (status == errSecSuccess) {
            status = -1;
        }
    }
    if (keychain != NULL) CFRelease(keychain);
    printf("build=%s operation=%s status=%d\n", BUILD_VERSION, argv[1], (int)status);
    return status == errSecSuccess ? 0 : 1;
}

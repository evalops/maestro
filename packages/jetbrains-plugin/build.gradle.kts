import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.25"
    id("org.jetbrains.intellij.platform") version "2.2.1"
}

group = "com.evalops"
version = "0.10.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.3")
        bundledPlugin("com.intellij.java")

        pluginVerifier()
        zipSigner()
        testFramework(TestFrameworkType.Platform)
    }

    // HTTP client with SSE support
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")

    // JSON serialization
    implementation("com.google.code.gson:gson:2.11.0")

    // Note: Kotlin coroutines are bundled with IntelliJ Platform - do not add explicitly

    // Testing
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testImplementation("io.mockk:mockk:1.13.10")
}

kotlin {
    jvmToolchain(21)
}

// Kotlin stdlib is handled via gradle.properties (kotlin.stdlib.default.dependency=false)
// and provided by IntelliJ Platform at runtime

intellijPlatform {
    pluginConfiguration {
        id = "com.evalops.composer"
        name = "Maestro"
        version = project.version.toString()
        description = """
            <p>Maestro - Deterministic AI coding assistant for JetBrains IDEs.</p>
            <p>Features:</p>
            <ul>
                <li>AI-powered code assistance with full transparency</li>
                <li>Multi-model support (Claude, GPT-4, Gemini, and more)</li>
                <li>IDE-aware context (diagnostics, definitions, references)</li>
                <li>Session management and history</li>
                <li>Tool execution with approval workflows</li>
            </ul>
            <p>Requires a running Maestro server. Start with: <code>maestro web</code></p>
        """.trimIndent()

        vendor {
            name = "EvalOps"
            email = "support@evalops.ai"
            url = "https://evalops.ai"
        }

        ideaVersion {
            sinceBuild = "243"
            untilBuild = provider { null }
        }

        changeNotes = """
            <h3>0.10.0</h3>
            <ul>
                <li>Initial release</li>
                <li>Chat interface with streaming support</li>
                <li>IDE integration for diagnostics, definitions, and references</li>
                <li>File context management</li>
                <li>Session switching and history</li>
            </ul>
        """.trimIndent()
    }

    signing {
        certificateChain = providers.environmentVariable("CERTIFICATE_CHAIN")
        privateKey = providers.environmentVariable("PRIVATE_KEY")
        password = providers.environmentVariable("PRIVATE_KEY_PASSWORD")
    }

    publishing {
        token = providers.environmentVariable("PUBLISH_TOKEN")
    }

    pluginVerification {
        ides {
            recommended()
        }
    }
}

tasks {
    test {
        useJUnitPlatform()
    }

    wrapper {
        gradleVersion = "8.11.1"
    }

    buildSearchableOptions {
        enabled = false
    }

}

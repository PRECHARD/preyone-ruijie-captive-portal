plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
    // Reads google-services.json (Firebase project: bus-ticket-app-aaecf).
    id("com.google.gms.google-services")
}

// Production release signing is driven exclusively by environment variables.
// Do NOT commit the keystore file or its passwords to the repository. When the
// variables are absent the release build stays unsigned (and will be rejected
// by the Play Console) instead of silently falling back to the debug keystore.
val releaseStoreFile = System.getenv("PREYONE_RELEASE_STORE_FILE")
val releaseStorePassword = System.getenv("PREYONE_RELEASE_STORE_PASSWORD")
val releaseKeyAlias = System.getenv("PREYONE_RELEASE_KEY_ALIAS")
val releaseKeyPassword = System.getenv("PREYONE_RELEASE_KEY_PASSWORD")
val hasReleaseSigning = !releaseStoreFile.isNullOrEmpty() &&
    !releaseStorePassword.isNullOrEmpty() &&
    !releaseKeyAlias.isNullOrEmpty() &&
    !releaseKeyPassword.isNullOrEmpty()

// Widened below the Flutter default (24) so older field terminals can run.
// The Firebase Android SDK (firebase-*/play-services-*) requires API 23, so
// this is the effective floor. NOTE: keep this as an indirection (NOT a bare
// literal) - Flutter's MinSdkVersionMigration rewrites any literal minSdk
// value in [16..23] back to flutter.minSdkVersion on every build.
val appMinSdkVersion = 23

android {
    namespace = "com.preyone.bus_ticket_app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.preyone.bus_ticket_app"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        // Android 6.0+ (API 23, defined above as appMinSdkVersion).
        // Widened from the Flutter default of 24 so older field terminals
        // can run the app; Firebase (crashlytics/messaging) requires 23.
        minSdk = appMinSdkVersion
        // Android 14 stable. Sideloaded enterprise APK - kept on a proven
        // stable target while compileSdk stays on Flutter's latest.
        targetSdk = 34
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseStoreFile)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            // Production keystore (env-provided). No debug fallback - a release
            // build without the keystore env vars remains unsigned.
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

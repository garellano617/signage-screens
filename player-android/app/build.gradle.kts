import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Optional portal address baked into the app: ./gradlew assembleRelease -PsignageServerUrl=http://host:3100
val serverUrl = (project.findProperty("signageServerUrl") as String?)?.trim().orEmpty()

// Optional release key: create keystore.properties next to settings.gradle.kts with
// storeFile=..., storePassword=..., keyAlias=..., keyPassword=...  (otherwise the debug key is used)
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.signage.player"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.signage.player"
        minSdk = 21
        targetSdk = 35
        // Every build gets a higher version number (minutes since 2025), so the newest build can always
        // replace the one on the TVs. A build server can set it: -PsignageVersionCode=…
        versionCode = (project.findProperty("signageVersionCode") as String?)?.toInt()
            ?: ((System.currentTimeMillis() / 60_000) - 29_000_000).toInt()
        versionName = "1.2.$versionCode"
        buildConfigField("String", "SERVER_URL", "\"$serverUrl\"")
    }

    signingConfigs {
        create("release") {
            if (keystoreProps.isNotEmpty()) {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName(if (keystoreProps.isNotEmpty()) "release" else "debug")
        }
    }

    buildFeatures { buildConfig = true }

    // The overlay layers (specials, text, effects) use the same files as the portal's live preview.
    sourceSets["main"].assets.srcDir("../../portal/public/overlay")

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = false
    }

    applicationVariants.all {
        val variant = this
        outputs.all {
            (this as com.android.build.gradle.internal.api.BaseVariantOutputImpl).outputFileName =
                "PremierSignage-${variant.versionName}-${variant.buildType.name}.apk"
        }
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("androidx.media3:media3-exoplayer:1.5.1")
    implementation("androidx.media3:media3-ui:1.5.1")
    // QR code on the pairing screen. 3.3.x: newer versions need Android 7+, the app supports 5+.
    implementation("com.google.zxing:core:3.3.3")
    testImplementation("junit:junit:4.13.2")
    // Real org.json in unit tests (Android's is only a stub there).
    testImplementation("org.json:json:20240303")
}

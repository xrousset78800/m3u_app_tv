import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Même numéro de version que l'appli Windows (package.json) : un seul `npm run release` pour les deux.
val repo = rootDir.parentFile
@Suppress("UNCHECKED_CAST")
val appVersion = (JsonSlurper().parse(File(repo, "package.json")) as Map<String, Any>)["version"] as String
val (major, minor, patch) = appVersion.split(".").map { it.toInt() }

// Clés TMDB et OpenSubtitles : fichiers ignorés par git, ou variables d'environnement (secrets GitHub).
fun key(name: String, env: String): String =
    System.getenv(env)?.trim()?.takeIf { it.isNotEmpty() }
        ?: File(repo, name).takeIf { it.exists() }?.readText()?.trim()
        ?: ""

fun quoted(text: String) = "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

// Interface : les fichiers de public/, tels quels, copiés dans l'APK.
val webDir = layout.buildDirectory.dir("generated/web")
val copyWeb by tasks.registering(Sync::class) {
    from(File(repo, "public"))
    into(webDir.map { it.dir("public") })
}

android {
    namespace = "fr.xouxou.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "fr.xouxou.tv"
        minSdk = 23
        targetSdk = 35
        versionCode = major * 10000 + minor * 100 + patch
        versionName = appVersion
        buildConfigField("String", "TMDB_KEY", quoted(key("tmdb.key", "TMDB_KEY")))
        buildConfigField("String", "OPENSUBTITLES_KEY", quoted(key("opensubtitles.key", "OPENSUBTITLES_KEY")))
    }

    // Signature des versions publiées : clé fournie par les secrets GitHub (voir release.yml).
    val keystore = System.getenv("ANDROID_KEYSTORE")?.let { File(it) }?.takeIf { it.exists() }
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = keystore
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    sourceSets["main"].assets.srcDir(webDir)
}

tasks.named("preBuild") { dependsOn(copyWeb) }

dependencies {
    val media3 = "1.5.1"
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-exoplayer-hls:$media3")
    implementation("androidx.media3:media3-ui:$media3")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    implementation("androidx.core:core:1.13.1")
}

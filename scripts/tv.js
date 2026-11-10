// npm run tv : compile l'appli Android TV, démarre la télé virtuelle, installe et lance l'appli.
// Outils attendus dans E:\Android (ou ANDROID_TOOLS) : jdk17, sdk, avd (télé « tv »).
//   npm run tv            compile, installe, lance
//   npm run tv -- --no-build   réinstalle l'APK déjà compilé
//   npm run tv -- --log   affiche ensuite le journal de l'appli
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const tools = process.env.ANDROID_TOOLS || 'E:\\Android';
const sdk = path.join(tools, 'sdk');
const adb = path.join(sdk, 'platform-tools', 'adb.exe');
const emulator = path.join(sdk, 'emulator', 'emulator.exe');
const project = path.join(__dirname, '..', 'android');
const apk = path.join(project, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const app = 'fr.xouxou.tv';
const args = process.argv.slice(2);

const env = {
  ...process.env,
  JAVA_HOME: path.join(tools, 'jdk17'),
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
  ANDROID_USER_HOME: path.join(tools, '.android'),
  ANDROID_AVD_HOME: path.join(tools, 'avd'),
  GRADLE_USER_HOME: path.join(tools, 'gradle-home'),
  TEMP: path.join(tools, 'tmp'),
  TMP: path.join(tools, 'tmp'),
};

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function run(file, list, options = {}) {
  const result = spawnSync(file, list, { env, stdio: 'inherit', ...options });
  if (result.status !== 0) fail(`Échec : ${path.basename(file)} ${list.join(' ')}`);
}

const out = (list) => spawnSync(adb, list, { env, encoding: 'utf8' }).stdout.trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  for (const file of [adb, emulator, env.JAVA_HOME]) if (!fs.existsSync(file)) fail(`Introuvable : ${file}`);

  // 1. La télé virtuelle (démarrée pendant la compilation).
  const running = /emulator-\d+\s+device/.test(out(['devices']));
  if (!running) {
    console.log('Démarrage de la télé virtuelle…');
    spawn(emulator, ['-avd', 'tv', '-no-snapshot-save', '-no-boot-anim'], { env, detached: true, stdio: 'ignore' }).unref();
  }

  // 2. L'APK.
  if (!args.includes('--no-build')) {
    const local = path.join(project, 'local.properties');
    if (!fs.existsSync(local)) fs.writeFileSync(local, `sdk.dir=${sdk.replace(/\\/g, '/').replace(':', '\\:')}\n`);
    console.log('Compilation…');
    run('"' + path.join(project, 'gradlew.bat') + '" assembleDebug --console=plain -q', [], { cwd: project, shell: true });
  }
  if (!fs.existsSync(apk)) fail('APK introuvable : lancer sans --no-build.');

  // 3. Attente du démarrage complet.
  console.log('Attente de la télé…');
  run(adb, ['wait-for-device']);
  for (let i = 0; out(['shell', 'getprop', 'sys.boot_completed']) !== '1'; i++) {
    if (i > 180) fail('La télé virtuelle ne démarre pas.');
    await sleep(1000);
  }

  // 4. Installation et lancement.
  console.log('Installation…');
  run(adb, ['install', '-r', apk]);
  run(adb, ['shell', 'am', 'force-stop', app]);
  run(adb, ['shell', 'am', 'start', '-n', `${app}/.MainActivity`]);
  console.log('Appli lancée. Télécommande : flèches, Entrée (OK), Échap (retour) dans la fenêtre de l\'émulateur.');
  console.log('Débogage de la page : chrome://inspect dans Chrome.');

  if (args.includes('--log')) {
    out(['logcat', '-c']);
    spawn(adb, ['logcat', '-v', 'time', '--pid', out(['shell', 'pidof', app]), '*:I'], { env, stdio: 'inherit' });
  }
}

main().catch((err) => fail(err.stack || String(err)));

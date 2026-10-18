import { readFileSync, writeFileSync } from "node:fs";

// `npm version <level>` runs this: copy the new package.json version into manifest.json and record
// which Obsidian version it needs in versions.json, so older Obsidian installs get a compatible release.
const targetVersion = process.env.npm_package_version;

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 4)}\n`);

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", `${JSON.stringify(versions, null, 4)}\n`);

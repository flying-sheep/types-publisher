import { clearOutputPath } from "./lib/package-generator";
import * as yargs from "yargs";

import { Options } from "./lib/common";
import { AllPackages, TypeScriptVersion, TypingsData } from "./lib/packages";
import NpmClient from "./lib/npm-client";
import { npmRegistry, outputPath } from "./lib/settings";
import { fetchLastPatchNumber, readAdditions } from "./lib/versions";
import { fetchJson, writeJson } from "./util/io";
import { Logger, logger, writeLog } from "./util/logging";
import { done, joinPaths, nAtATime } from "./util/util";

const packageName = "types-registry";
const registryOutputPath = joinPaths(outputPath, packageName);
const readme =
`This package contains a listing of all packages published to the @types scope on NPM.
Generated by [types-publisher](https://github.com/Microsoft/types-publisher).`;

if (!module.parent) {
	const dry = !!yargs.argv.dry;
	done(main(dry));
}

export default async function main(dry = false) {
	const [log, logResult] = logger();
	log("=== Publishing types-registry ===");

	// Only need to publish a new registry if there are new packages.
	const added = await readAdditions();
	if (added.length) {
		log(`New packages have been added: ${JSON.stringify(added)}, so publishing a new registry`);
		await generateAndPublishRegistry(log, Options.defaults, dry);
	} else {
		log("No new packages published, so no need to publish new registry.");
	}

	await writeLog("publish-registry.md", logResult());
}

async function generateAndPublishRegistry(log: Logger, options: Options, dry: boolean) {
	// Don't include not-needed packages in the registry.
	const typings = await AllPackages.readTypings();

	const last = await fetchLastPatchNumber(packageName);
	const packageJson = generatePackageJson(last + 1);

	await generate(typings, packageJson, log, options);
	await publish(packageJson, dry);
}

async function generate(typings: TypingsData[], packageJson: {}, log: Logger, options: Options): Promise<void> {
	await clearOutputPath(registryOutputPath, log);
	await writeOutputFile("package.json", packageJson);
	await writeOutputFile("index.json", await generateRegistry(typings, options));
	await writeOutputFile("README.md", readme);

	function writeOutputFile(filename: string, content: {}): Promise<void> {
		return writeJson(joinPaths(registryOutputPath, filename), content);
	}
}

async function publish(packageJson: {}, dry: boolean): Promise<void> {
	const client = await NpmClient.create();
	await client.publish(registryOutputPath, packageJson, dry);
}

function generatePackageJson(patch: number): {} {
	return {
		name: packageName,
		version: `0.1.${patch}`,
		description: "A registry of TypeScript declaration file packages published within the @types scope.",
		repository: {
			type: "git",
			url: "https://github.com/Microsoft/types-publisher.git"
		},
		keywords: [
			"TypeScript",
			"declaration",
			"files",
			"types",
			"packages"
		],
		author: "Microsoft Corp.",
		license: "Apache-2.0"
	};
}

interface Registry {
	entries: Entries
}
interface Entries {
	[key: string]: Versions;
}
type Versions = Partial<Record<TypeScriptVersion.VersionTag, string>>;

async function generateRegistry(typings: TypingsData[], options: Options): Promise<Registry> {
	const entries: Entries = {};
	await nAtATime(25, typings, addEntry, { name: "Generating registry...", flavor: t => t.name, options });
	return { entries };

	async function addEntry(typing: TypingsData): Promise<void> {
		const versions = await getVersions(typing.fullEscapedNpmName);
		entries[typing.name] = versions;
	}
}

async function getVersions(escapedPackageName: string): Promise<Versions> {
	const uri = npmRegistry + escapedPackageName;
	const info = await fetchJson(uri, { retries: true });
	const tags = info["dist-tags"];
	return pick(tags, TypeScriptVersion.allVersionTags);
}

function pick<T, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
	const out = {} as Pick<T, K>;
	for (const key in obj) {
		if (keys.includes(key as K)) {
			out[key] = obj[key];
		}
	}
	return out;
}

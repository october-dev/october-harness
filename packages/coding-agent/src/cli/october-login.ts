import chalk from "chalk";
import { APP_NAME, getAuthPath } from "../config.ts";
import { logoutOctober, storeOctoberInferenceToken } from "../extensions/october/auth.ts";
import { printOctoberDeviceCode, runOctoberDeviceCodeLogin } from "../extensions/october/device-code.ts";

export function isOctoberLoginCommand(args: string[]): boolean {
	return args[0] === "login" && (args[1] === undefined || args[1] === "october" || args[1].startsWith("-"));
}

export function isOctoberLogoutCommand(args: string[]): boolean {
	return args[0] === "logout" && (args[1] === undefined || args[1] === "october" || args[1].startsWith("-"));
}

export function printOctoberLoginHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${APP_NAME} login [october]
  ${APP_NAME} logout [october]

Sign in with your October account using a device code, or remove a stored October token.
When the october.dev device-code endpoints are not live yet, login prints a clear error
and you can use the October app or OCTOBER_INFERENCE_TOKEN instead.
`);
}

export async function handleOctoberLoginCommand(args: string[]): Promise<boolean> {
	if (args.includes("-h") || args.includes("--help")) {
		printOctoberLoginHelp();
		return true;
	}
	if (isOctoberLogoutCommand(args)) {
		const removed = await logoutOctober(getAuthPath());
		if (!removed) {
			console.error(chalk.yellow("No stored October credential to remove."));
			process.exitCode = 1;
			return true;
		}
		console.log(chalk.green("Logged out of October."));
		return true;
	}
	if (!isOctoberLoginCommand(args)) {
		return false;
	}
	try {
		const token = await runOctoberDeviceCodeLogin({
			onDeviceCode: printOctoberDeviceCode,
		});
		await storeOctoberInferenceToken(token);
		console.log(chalk.green("Signed in to October. You can use --provider october."));
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(message));
		process.exitCode = 1;
	}
	return true;
}

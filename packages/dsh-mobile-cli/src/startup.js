/**
 * @bb-84c/dsh-mobile-cli — cmdline plugin entry for the `mobile` dsh profile.
 *
 * The stock dsh launcher hands everything after `--profile mobile` to this
 * profile's app tree through the `cmdlineArgs` service. This plugin owns the
 * whole command line: it builds the commander program, dispatches actions to
 * commands.js, and exits through `appExit` (the same contract the shipped
 * web app's startup plugin uses).
 */

import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";
import { runCommand } from "./commands.js";

export const name = "mobile-startup";
export const inject = ["cmdlineArgs"];

/**
 * Subcommand table. Each entry becomes one commander subcommand; positional
 * arguments arrive as a string array, options as commander options.
 */
const SUBCOMMANDS = [
  {
    name: "install",
    description: "install/repair the mobile plugins into the mobile and web profiles (idempotent)",
    argsDesc: "",
    options: [],
  },
  {
    name: "uninstall",
    description: "remove the mobile plugins from both profiles (keeps your data under $DSH_HOME/mobile)",
    argsDesc: "",
    options: [],
  },
  {
    name: "status",
    description: "overview: resident service, tailscale, relay, paired devices",
    argsDesc: "",
    options: [],
  },
  {
    name: "service",
    description: "low-level lifecycle in the currently configured transport (auto-start templates use this) — prefer tailscale start / relay start",
    argsDesc: "<action> [n]",
    options: [],
  },
  {
    name: "tailscale",
    description: "tailscale transport (b) — start | stop | restart | logs [n] | status | ip | connect | ping [host] | serve [on|off|status]",
    argsDesc: "<action> [args...]",
    options: [],
  },
  {
    name: "relay",
    description: "VPS relay transport (c) — connect <relay-url> | disconnect | start | stop | restart | logs [n] | status | ping",
    argsDesc: "<action> [relay-url]",
    options: [
      ["--token <token>", "instance token issued by the relay owner"],
      ["--id <id>", "instance id (defaults to the machine hostname)"],
      ["--name <name>", "display name shown in the relay directory"],
    ],
  },
  {
    name: "device",
    description: "device pairing and management — pair | list | revoke <id>",
    argsDesc: "<action> [id]",
    options: [["--name <name>", "device name (pair)"]],
  },
  {
    name: "url",
    description: "print the URL to open the remote dsh Web UI on your phone",
    argsDesc: "",
    options: [],
  },
  {
    name: "config",
    description: "read/write the mobile config — show | get <key> | set <key> <value>",
    argsDesc: "<action> [key] [value]",
    options: [],
  },
  {
    name: "doctor",
    description: "diagnostics: versions, ports, tailscale, relay reachability",
    argsDesc: "",
    options: [],
  },
  {
    name: "update",
    description: "update the plugin packages in both profiles (forwards to dsh plugin update)",
    argsDesc: "",
    options: [],
  },
];

/**
 * Cordis plugin apply. Parses the command line once and dispatches; the
 * action of the invoked command runs the command and requests process exit.
 */
export function apply(ctx) {
  const program = new Command()
    .name("dsh --profile mobile")
    .description("DeepSeek Harness mobile solution — reach your resident dsh from any device.")
    .helpOption("-h, --help", "show this help");

  for (const sub of SUBCOMMANDS) {
    const cmd = program
      .command(sub.name)
      .description(sub.description)
      .argument("[args...]", sub.argsDesc)
      .allowUnknownOption(true)
      .allowExcessArguments(true);
    for (const [flags, description] of sub.options) cmd.option(flags, description);
    cmd.action(async (args, options) => {
      let code;
      try {
        code = await runCommand(sub.name, args ?? [], options);
      } catch (error) {
        console.error(`dsh mobile: ${error instanceof Error ? error.message : String(error)}`);
        code = 1;
      }
      ctx.appExit(code);
    });
  }

  program.action(() => {
    program.help();
  });

  parseCmdline(ctx, program);
}

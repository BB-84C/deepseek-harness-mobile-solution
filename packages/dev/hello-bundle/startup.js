/**
 * Dev probe plugin: prove the `dsh --profile mobile` boot path —
 * (1) `dsh plugin --profile mobile add link:<this repo>` composes a
 *     `dsh.bundle.patch`-declaring package into the profile bundle stack,
 * (2) launcher args reach the plugin via the `cmdlineArgs` service,
 * (3) `appExit` terminates the process cleanly.
 * No dependencies: parses nothing, prints the raw args.
 */

export const name = "hello-startup";
export const inject = ["cmdlineArgs"];

export function apply(ctx) {
  const args = ctx.get("cmdlineArgs");
  const exit = ctx.get("appExit");
  if (args === undefined || exit === undefined) {
    throw new Error("hello-startup: launcher did not provide cmdlineArgs/appExit");
  }
  console.log("HELLO-ARGS " + JSON.stringify(args.get()));
  exit(0);
}

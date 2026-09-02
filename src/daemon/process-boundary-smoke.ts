import { assertDaemonEnvironmentPrivate } from "./process-boundary";

assertDaemonEnvironmentPrivate();
process.stdout.write("process boundary smoke passed\n");

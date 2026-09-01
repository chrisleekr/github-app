/*
 * Loaded with LD_PRELOAD before Bun starts.
 *
 * Worker environment variables contain credentials that same-UID agent
 * children must not read through /proc/<pid>/environ. Mark the parent
 * non-dumpable and fail closed if Linux cannot enforce the boundary.
 */

#include <stddef.h>
#include <sys/prctl.h>
#include <unistd.h>

static void fail_guard(const char *message, size_t length) {
  (void)write(STDERR_FILENO, message, length);
  _exit(78);
}

__attribute__((constructor)) static void protect_daemon_environment(void) {
  static const char set_failed[] =
      "github-app daemon guard: PR_SET_DUMPABLE failed\n";
  static const char verify_failed[] =
      "github-app daemon guard: process remained dumpable\n";

  if (prctl(PR_SET_DUMPABLE, 0L, 0L, 0L, 0L) == -1) {
    fail_guard(set_failed, sizeof(set_failed) - 1);
  }
  if (prctl(PR_GET_DUMPABLE, 0L, 0L, 0L, 0L) != 0) {
    fail_guard(verify_failed, sizeof(verify_failed) - 1);
  }
}

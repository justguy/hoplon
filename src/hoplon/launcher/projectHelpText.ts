import { PROJECT_LIFECYCLE_HELP_TEXT } from './projectLifecycleCli.js';
import { PROJECT_POLICY_HELP_TEXT } from './projectPolicyCli.js';

export const PROJECT_HELP_TEXT = `hoplon project - multi-project registration (t-080)

Usage:
  hoplon project list
  hoplon project register --project-id <id> --fs-root <dir> [options]
  hoplon project unregister --project-id <id>
  hoplon project select --project-id <id>
  hoplon project clear-active
  hoplon project show --project-id <id>
  hoplon project policy <subcommand>     (see policy subcommands below)
  hoplon project handshake --project-id <id> --folder <rel-path> [--principal-id <p>]
  hoplon project renew --token <opaque>
  hoplon project revoke --token <opaque>
  hoplon project prune

Register options:
  --label <text>            Human-readable label (default: projectId)
  --engine-id <id>          Engine identity (default: local-<projectId>)
  --git-repo-dir <dir>      Internal git repo dir (default: .hoplon/repo)
  --grammars-dir <dir>      Tree-sitter grammars dir (default: <fsRoot>/vendor/grammars)
  --db-path <path>          SQLite snapshot registry (default: <fsRoot>/.hoplon/hoplon.db)
  --folder-policy-file <p>  Path to a JSON file with the folder-scoped policy.
                            Required before projects_handshake can issue an
                            engagement token for this project.

Minimal folder policy:
  {"defaultAccess":"read_only","engagementTokenTtlMs":60000,"folderRules":[{"folder":"","access":"read_only"}]}

Handshake (t-083):
  Issues an engagement-token envelope bound to projectId + canonical folder
  + access mode + expiry. The folder is canonicalized as project-relative;
  use --folder= for the project root. Absolute paths, '..' segments, and
  backslashes are rejected before a rule is consulted. Principal filtering is
  honored when the project's folder policy declares principals.

Registered projects persist to <launcherRoot>/.hoplon/projects.json.
The launcher's CWD remains the default "active" scope unless select is run.
MCP agents cannot mutate registration or folder policy through the agent tool
profile. A trusted shell-capable agent may run this host CLI from the same
launcher root; an MCP-only agent must ask the host/operator or admin HTTP
surface.
Random folder flow:
  1. Register once with the same launcher root used by MCP/HTTP:
     hoplon project register --project-id Project-A --fs-root /path/to/project-a --folder-policy-file /path/to/policy.json
  2. Already-running packaged MCP/HTTP launchers refresh the durable catalog
     before project lookups. If CLI show succeeds but MCP returns
     unknown_project with a different registeredProjectIds list, the CLI and
     MCP are using different launcher roots; register in the MCP launcher root
     or restart MCP from the intended root.
  3. Read with request projectId=Project-A; start edit sessions with
     start_edit_session and manifest.projectId=Project-A; engine preflight is not a session start.
  4. Continue session calls by returned sessionId. session_list shows live
     edit sessions, not projects.

${PROJECT_LIFECYCLE_HELP_TEXT}
${PROJECT_POLICY_HELP_TEXT}`;

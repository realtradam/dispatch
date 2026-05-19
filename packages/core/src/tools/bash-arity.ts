// Hardcoded dictionary of well-known commands and their arity
// (number of tokens that form the "human-understandable" prefix)
const ARITY: Record<string, number> = {
	"git": 2,        // "git checkout", "git commit", etc.
	"npm": 3,        // "npm run dev", "npm install -g"
	"docker": 2,     // "docker compose", "docker build"
	"kubectl": 2,    // "kubectl get", "kubectl apply"
	"bun": 2,        // "bun install", "bun test"
	"cargo": 2,      // "cargo build", "cargo test"
	"go": 2,         // "go build", "go test"
	"python": 2,     // "python -m", "python script.py"
	"python3": 2,
	"pip": 2,
	"pip3": 2,
	"brew": 2,
	"apt": 2,
	"apt-get": 2,
	"dnf": 2,
	"yum": 2,
	"pacman": 2,
	"systemctl": 2,
	"journalctl": 2,
	"ssh": 2,
	"scp": 2,
	"rsync": 2,
	"curl": 2,       // "curl -X", "curl https://"
	"wget": 2,
	"tar": 2,        // "tar -xzf", "tar -czf"
	"zip": 2,
	"unzip": 2,
	"chown": 2,
	"chmod": 2,
	"mount": 2,
	"umount": 2,
	// Default: all other commands are arity 1
};

// Get the normalized prefix for a list of tokens
export function prefix(tokens: string[]): string[] {
	if (tokens.length === 0) return [];
	const first = tokens[0];
	if (!first) return [];
	const arity = ARITY[first.toLowerCase()];
	if (arity === undefined) {
		return [first];
	}
	return tokens.slice(0, arity);
}

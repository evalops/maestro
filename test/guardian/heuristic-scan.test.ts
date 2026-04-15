import { describe, expect, it } from "vitest";
import { detectHeuristicFindings } from "../../src/guardian/runner.js";

// Split tokens to avoid triggering secret scanners in the repo.
const joinParts = (...parts: string[]) => parts.join("");
const joinWords = (...parts: string[]) => parts.join(" ");
const AWS_ACCESS_KEY = joinParts("AK", "IA", "IOSFODNN7", "EXAMPLE");
const AWS_SECRET_KEY = joinParts(
	"wJalrXUtnFEMI/K7MDENG/bPxRfi",
	"CYEXAMPLEKEY",
);
const RSA_PRIVATE_KEY = joinParts(
	"-----BEGIN ",
	joinWords("RSA", "PRIVATE", "KEY"),
	"-----\nMIIE...",
);
const GENERIC_PRIVATE_KEY = joinParts(
	"-----BEGIN ",
	joinWords("PRIVATE", "KEY"),
	"-----\nMIIE...",
);
const GITHUB_TOKEN = joinParts(
	"gh",
	"p_",
	"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1234",
);
const GITHUB_PAT = joinParts(
	"github",
	"_pat_",
	"11AAAAAAA0",
	"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
);
const GITLAB_TOKEN = joinParts("gl", "pat-", "xxxxxxxxxxxxxxxxxxxx");
const GOOGLE_API_KEY = joinParts(
	"AI",
	"za",
	"SyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe",
);
const STRIPE_SECRET_KEY = joinParts(
	"sk",
	"_",
	"live_",
	"51HxxxxxxxxxxxxxxxxXXXXXXXXXXXXXXXXXXXX",
);
const STRIPE_PUBLISHABLE_KEY = joinParts(
	"pk",
	"_",
	"test_",
	"51HxxxxxxxxxxxxxxxxXXXXXXXXXXXXXXXXXXXX",
);
const OPENAI_API_KEY = joinParts(
	"sk",
	"-",
	"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
);
const SENDGRID_API_KEY = joinParts(
	"SG",
	".",
	"xxxxxxxxxxxxxxxxxxxxxx",
	".",
	"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
);
const TWILIO_AUTH_TOKEN = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

describe("guardian heuristic scan", () => {
	describe("Generic API key", () => {
		it("does not flag natural language token text in concatenated strings", () => {
			const contents = 'const msg = "Token: " + "xoxb-FAKE-TEST-TOKEN-abc";\n';
			expect(detectHeuristicFindings(contents)).toEqual([]);
		});

		it("flags identifier-style token assignments", () => {
			const contents =
				'const cfg = { token: "abcdefghijklmnopqrstuvwxyz0123456789" };\n';
			expect(detectHeuristicFindings(contents)).toContain("Generic API key");
		});

		it("flags JSON-style token keys", () => {
			const contents = '{ "token": "abcdefghijklmnopqrstuvwxyz0123456789" }\n';
			expect(detectHeuristicFindings(contents)).toContain("Generic API key");
		});
	});

	describe("Slack token", () => {
		it("flags Slack token shapes with numeric segments", () => {
			const contents =
				'const t = "xoxb-123456789-123456789-abcDEF0123456789";\n';
			expect(detectHeuristicFindings(contents)).toContain("Slack token");
		});
	});

	describe("AWS credentials", () => {
		it("flags AWS access key ID", () => {
			const contents = `AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY}\n`;
			expect(detectHeuristicFindings(contents)).toContain("AWS access key");
		});

		it("flags AWS secret access key", () => {
			const contents = `aws_secret_access_key = "${AWS_SECRET_KEY}"\n`;
			expect(detectHeuristicFindings(contents)).toContain("AWS secret key");
		});
	});

	describe("Private key", () => {
		it("flags RSA private key block", () => {
			const contents = RSA_PRIVATE_KEY;
			expect(detectHeuristicFindings(contents)).toContain("Private key block");
		});

		it("flags generic private key block", () => {
			const contents = GENERIC_PRIVATE_KEY;
			expect(detectHeuristicFindings(contents)).toContain("Private key block");
		});
	});

	describe("GitHub token", () => {
		it("flags GitHub personal access token (ghp_)", () => {
			const contents = `GITHUB_TOKEN=${GITHUB_TOKEN}\n`;
			expect(detectHeuristicFindings(contents)).toContain("GitHub token");
		});

		it("flags GitHub fine-grained PAT (github_pat_)", () => {
			const contents = `token: "${GITHUB_PAT}"\n`;
			expect(detectHeuristicFindings(contents)).toContain("GitHub token");
		});
	});

	describe("GitLab token", () => {
		it("flags GitLab personal access token", () => {
			const contents = `GITLAB_TOKEN=${GITLAB_TOKEN}\n`;
			expect(detectHeuristicFindings(contents)).toContain("GitLab token");
		});
	});

	describe("Google API key", () => {
		it("flags Google API key", () => {
			const contents = `const apiKey = "${GOOGLE_API_KEY}";\n`;
			expect(detectHeuristicFindings(contents)).toContain("Google API key");
		});
	});

	describe("Stripe key", () => {
		it("flags Stripe live secret key", () => {
			const contents = `STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY}\n`;
			expect(detectHeuristicFindings(contents)).toContain("Stripe key");
		});

		it("flags Stripe test publishable key", () => {
			const contents = `${STRIPE_PUBLISHABLE_KEY}\n`;
			expect(detectHeuristicFindings(contents)).toContain("Stripe key");
		});
	});

	describe("OpenAI API key", () => {
		it("flags OpenAI API key", () => {
			const contents = `OPENAI_API_KEY=${OPENAI_API_KEY}\n`;
			expect(detectHeuristicFindings(contents)).toContain("OpenAI API key");
		});
	});

	describe("SendGrid API key", () => {
		it("flags SendGrid API key", () => {
			const contents = `SENDGRID_API_KEY=${SENDGRID_API_KEY}\n`;
			expect(detectHeuristicFindings(contents)).toContain("SendGrid API key");
		});
	});

	describe("Twilio credentials", () => {
		it("flags Twilio auth token", () => {
			const contents = `TWILIO_AUTH_TOKEN = "${TWILIO_AUTH_TOKEN}"\n`;
			expect(detectHeuristicFindings(contents)).toContain("Twilio auth token");
		});
	});

	describe("Discord webhook", () => {
		it("flags Discord webhook URL", () => {
			const contents =
				'webhookUrl = "https://discord.com/api/webhooks/1234567890/abcDEF123456_xyz-ABC"\n';
			expect(detectHeuristicFindings(contents)).toContain("Discord webhook");
		});
	});

	describe("Database URL with credentials", () => {
		it("flags PostgreSQL connection string with password", () => {
			const contents =
				"DATABASE_URL=postgres://myuser:secretpass@localhost:5432/mydb\n";
			expect(detectHeuristicFindings(contents)).toContain(
				"Database URL with credentials",
			);
		});

		it("flags MongoDB connection string with password", () => {
			const contents =
				'MONGO_URI="mongodb+srv://admin:password123@cluster.mongodb.net/db"\n';
			expect(detectHeuristicFindings(contents)).toContain(
				"Database URL with credentials",
			);
		});

		it("flags usernames containing @ symbols", () => {
			const contents =
				'MONGO_URI="mongodb+srv://admin@company.com:password@cluster.mongodb.net/db"\n';
			expect(detectHeuristicFindings(contents)).toContain(
				"Database URL with credentials",
			);
		});

		it("does not flag query-parameter credentials", () => {
			const contents =
				"DATABASE_URL=postgresql://localhost:5432/composer?user=app&password=secret\n";
			expect(detectHeuristicFindings(contents)).not.toContain(
				"Database URL with credentials",
			);
		});
	});

	describe("JWT token", () => {
		it("flags JWT token", () => {
			// This is a synthetic JWT-like structure for testing
			const contents =
				'token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.Sfl8KxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"\n';
			expect(detectHeuristicFindings(contents)).toContain("JWT token");
		});
	});
});

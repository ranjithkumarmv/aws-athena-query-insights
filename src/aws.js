import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    AthenaClient,
    BatchGetQueryExecutionCommand,
    ListQueryExecutionsCommand,
    ListWorkGroupsCommand,
} from "@aws-sdk/client-athena";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { fromNodeProviderChain, fromTemporaryCredentials } from "@aws-sdk/credential-providers";

const CLIENT_OPTS = { maxAttempts: 10, retryMode: "adaptive" };

/** Profile names from ~/.aws/config and ~/.aws/credentials (names only, never secrets). */
export function listProfiles(env = process.env) {
    const files = [
        env.AWS_CONFIG_FILE || join(homedir(), ".aws", "config"),
        env.AWS_SHARED_CREDENTIALS_FILE || join(homedir(), ".aws", "credentials"),
    ];
    const names = new Set();
    for (const file of files) {
        let text;
        try {
            text = readFileSync(file, "utf8");
        } catch {
            continue;
        }
        for (const m of text.matchAll(/^\s*\[\s*(?:profile\s+)?([^\]\s]+)\s*\]/gm)) {
            if (m[1] !== "sso-session" && !m[0].includes("sso-session")) names.add(m[1]);
        }
    }
    return [...names].sort();
}

/** Region from the profile / AWS env, used when no region is configured. */
export async function defaultRegion(profile) {
    try {
        // The SDK resolves AWS_REGION, then the profile's region setting.
        return await new AthenaClient({ profile: profile ?? undefined }).config.region();
    } catch {
        return null;
    }
}

export function baseCredentials(profile) {
    return fromNodeProviderChain(profile ? { profile } : {});
}

export function roleCredentials(base, roleArn) {
    return fromTemporaryCredentials({
        masterCredentials: base,
        params: { RoleArn: roleArn, RoleSessionName: "athena-query-insights", DurationSeconds: 3600 },
    });
}

/** Thin wrapper so the fetcher can be tested with a fake. */
export class AwsApi {
    constructor({ region, credentials }) {
        this.region = region;
        this.athena = new AthenaClient({ region, credentials, ...CLIENT_OPTS });
        this.sts = new STSClient({ region, credentials, ...CLIENT_OPTS });
    }

    async accountId() {
        return (await this.sts.send(new GetCallerIdentityCommand({}))).Account;
    }

    async listWorkGroups(signal) {
        const out = [];
        let NextToken;
        do {
            const page = await this.athena.send(new ListWorkGroupsCommand({ MaxResults: 50, NextToken }), { abortSignal: signal });
            for (const wg of page.WorkGroups ?? []) out.push({ name: wg.Name, state: wg.State });
            NextToken = page.NextToken;
        } while (NextToken);
        return out;
    }

    /** One page of query ids, newest first. */
    async listQueryExecutions(workgroup, nextToken, signal) {
        const page = await this.athena.send(
            new ListQueryExecutionsCommand({ WorkGroup: workgroup, MaxResults: 50, NextToken: nextToken }),
            { abortSignal: signal },
        );
        return { ids: page.QueryExecutionIds ?? [], nextToken: page.NextToken };
    }

    async batchGetQueryExecution(ids, signal) {
        const r = await this.athena.send(new BatchGetQueryExecutionCommand({ QueryExecutionIds: ids }), { abortSignal: signal });
        return { executions: r.QueryExecutions ?? [], unprocessed: r.UnprocessedQueryExecutionIds ?? [] };
    }
}

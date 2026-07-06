import path from 'node:path';
import dotenv from 'dotenv';
import { PROJECT_ROOT } from './paths.js';

// Load secrets from the project-root .env regardless of the current working dir.
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

export interface Env {
  jiraBaseUrl: string;
  jiraEmail: string;
  jiraApiToken: string;
  githubToken: string;
  githubOrg: string;
  port: number;
  configPath: string;
}

/**
 * Reads and validates the environment. Throws if a required secret is missing,
 * so failures are explicit at startup instead of on the first API call.
 */
export function loadEnv(): Env {
  const configPath = optional('CONFIG_PATH', path.join(PROJECT_ROOT, 'config.yaml'));
  return {
    jiraBaseUrl: required('JIRA_BASE_URL').replace(/\/+$/, ''),
    jiraEmail: required('JIRA_EMAIL'),
    jiraApiToken: required('JIRA_API_TOKEN'),
    githubToken: required('GITHUB_TOKEN'),
    githubOrg: required('GITHUB_ORG'),
    port: Number(optional('PORT', '4000')),
    configPath: path.isAbsolute(configPath) ? configPath : path.join(PROJECT_ROOT, configPath),
  };
}

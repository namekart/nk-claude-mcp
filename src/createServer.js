/**
 * Shared MCP server + tool registration for stdio and Streamable HTTP.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getApprovalFeedback,
  getOrderResults,
  getRecoHubDomains,
  submitClaudeRecos,
} from "./dashboard.js";
import { DEFAULT_AI_EXPORT_CONTEXT } from "./recoPrompt.js";

export const TOOL_NAMES =
  "get_reco_prompt,get_reco_hub_domains,submit_claude_recos,get_approval_feedback,get_order_results";

const SERVER_INSTRUCTIONS = [
  "You give acquisition recos on Namekart's Dashboard as the Claude user, through the same flow analysts use.",
  "Before recommending, call get_approval_feedback and get_order_results and learn from them:",
  "where the final APR differed from your reco (overridden = true), read aprRemark to understand why,",
  "and adjust similar future recos. Call get_reco_prompt for the field glossary and rules.",
  "Every reco you submit moves the domain to the approval stage, exactly like an analyst reco.",
].join(" ");

export function createNkClaudeServer() {
  const server = new McpServer(
    {
      name: "nk-claude-mcp",
      version: "0.5.0",
    },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.registerTool(
    "get_reco_prompt",
    {
      description:
        "Return Claude reco instructions: field glossary, rules, and required JSON output format.",
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(DEFAULT_AI_EXPORT_CONTEXT, null, 2),
        },
      ],
    })
  );

  server.registerTool(
    "get_reco_hub_domains",
    {
      description:
        "Fetch Acquisition Reco Hub rows from NKDashboard (full payload), with the same filters and sorting as the Reco Hub UI. " +
        "Translate the user's request into filters, e.g. 'GD .com domains under $100 ending this week' -> " +
        "list contains GD, tld equals com, price lessthan 100, edate between today and +7 days. " +
        "Filter fields are Reco Hub row field names (see get_reco_prompt glossary). Common ones and their type: " +
        "text: domain, list, host, tld, listingType; number: price, current, bids, len, age, gdv, est, sg, traffic, reco, apr, wbyYear; " +
        "date (YYYY-MM-DD): edate; datetime (YYYY-MM-DDTHH:mm:ss): createdAt. " +
        "Same filter map as the Reco Hub UI, including OR (logicalOperator), agents (field agents, agent_type uploader, researcher, processor, reviewer, recommender, approver, shortlister, contributingUser), " +
        "LSB marks (type lsb, operator isMarkedAs, isNotMarkedAs, markCountAtLeast, onlyMarked), and prospect flags (field flagValue or flagReason). " +
        "Decision Hub chips go in toggles: endingIn 12h/24h/48h, showExpired Yes/No, myRecoGiven and othersRecoGiven Yes/No/Pending, lead, social, emails, wordCount ONE/TWO, tld, researchStatus Human/AI/Both/None. " +
        "For '.ai domains' filter domain endswith .ai, not the tld column (that column is often empty). " +
        "Always report the filters you applied (appliedFilters) back to the user.",
      inputSchema: {
        sourceType: z
          .enum(["ed", "es", "pd", "ltd", "all"])
          .default("ed")
          .describe("Reco Hub mode"),
        tab: z.string().default("ALL").describe("Reco Hub tab"),
        page: z.number().int().min(0).default(0),
        size: z.number().int().min(1).max(200).default(20).describe("Rows in this page, up to 200"),
        search: z.string().optional().describe("Free-text domain search (min 3 chars)"),
        searchDomains: z.array(z.string()).optional().describe("Exact domain names"),
        filters: z
          .array(
            z.object({
              field: z.string().describe("Row field, or agents / flagValue / flagReason / lsb"),
              type: z
                .string()
                .describe("text, number, date, datetime, boolean, or lsb"),
              operator: z
                .string()
                .describe(
                  "Any Reco Hub operator: equals, notequals, contains, notcontains, startswith, endswith, " +
                    "greaterthan, gte, lessthan, between, before, after, isempty, isnotempty, isMarkedAs"
                ),
              value: z
                .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
                .optional()
                .describe("Value; an array with equals means any of these"),
              value2: z
                .union([z.string(), z.number()])
                .optional()
                .describe("Upper bound, only for between"),
              logicalOperator: z
                .enum(["AND", "OR"])
                .optional()
                .describe("How this filter joins the previous one. Default AND"),
              agent_type: z
                .string()
                .optional()
                .describe("Required when field is agents: uploader, researcher, processor, reviewer, recommender, approver, shortlister, or contributingUser"),
            })
          )
          .optional()
          .describe("Combined in order. A filter with logicalOperator OR is OR-ed with the previous filter"),
        sort: z
          .array(
            z.object({
              field: z.string(),
              direction: z.enum(["asc", "desc"]),
            })
          )
          .optional()
          .describe("Sort order, e.g. [{field:'edate',direction:'asc'}]"),
        includeExpired: z
          .boolean()
          .default(false)
          .describe("Include listings the platform no longer finds"),
        withLeadsOnly: z.boolean().default(false).describe("Only domains that have leads"),
        nlOnly: z.boolean().default(false).describe("Only no-lead domains (Reco Hub NL toggle)"),
        preLiveOnly: z.boolean().default(false).describe("Only pre-live auction domains"),
        toggles: z
          .object({
            endingIn: z.enum(["12h", "24h", "48h"]).optional().describe("Auction ends within this window"),
            showExpired: z.enum(["Yes", "No"]).optional().describe("Expired listings: Yes only expired, No hide them"),
            myRecoGiven: z.enum(["Yes", "No", "Pending"]).optional().describe("Claude user's own reco"),
            othersRecoGiven: z.enum(["Yes", "No", "Pending"]).optional().describe("Other people's recos"),
            lead: z.enum(["Yes", "No", "Pending"]).optional(),
            social: z.enum(["Yes", "No"]).optional(),
            emails: z.enum(["Yes", "No"]).optional(),
            wordCount: z.enum(["ONE", "TWO"]).optional(),
            tld: z.string().optional().describe("TLD chip, e.g. com or ai"),
            wby: z.string().optional(),
            aby: z.string().optional(),
            ns: z.string().optional(),
            researchStatus: z.enum(["Human", "AI", "Both", "None"]).optional(),
          })
          .optional()
          .describe("Decision Hub chip toggles. Omit a key, or All, to leave that chip off"),
      },
    },
    async (args) => {
      try {
        const data = await getRecoHubDomains(args);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to fetch Reco Hub: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "submit_claude_recos",
    {
      description:
        "Save one reco on an Acquisition Reco Hub domain as the Claude user, through the normal analyst reco flow. " +
        "It becomes the domain's reco (recoBy = Claude), is added to the reco history, and moves the domain to the approval stage. " +
        "Check get_approval_feedback first.",
      inputSchema: {
        domainId: z.number().describe("AcquShortlistedDomain id"),
        reco: z.number().int().describe("Recommended acquisition bid in USD (integer)"),
        reasoning: z
          .string()
          .min(1)
          .describe("Short reason for the reco; saved as the reco remark"),
      },
    },
    async ({ domainId, reco, reasoning }) => {
      try {
        const data = await submitClaudeRecos([{ domainId, reco, reasoning }]);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to save Claude recos: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_approval_feedback",
    {
      description:
        "Read the final APR and APR remark for domains Claude has recommended. Call this before giving new recos. " +
        "overridden is true when the final APR differs from Claude's reco; aprRemark then explains why.",
      inputSchema: {
        size: z.number().int().min(1).max(50).default(20),
        searchDomains: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      try {
        const data = await getApprovalFeedback(args);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to fetch approval feedback: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_order_results",
    {
      description:
        "Read order and auction outcomes for domains that already have a Claude reco. result is IN_ORDER, ORDER_PLACED, ORDER_MISSED, WON, or LOST.",
      inputSchema: {
        size: z.number().int().min(1).max(50).default(20),
      },
    },
    async (args) => {
      try {
        const data = await getOrderResults(args);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to fetch order results: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

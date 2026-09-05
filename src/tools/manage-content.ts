/**
 * Brightspace MCP Server
 * Copyright (c) 2025 Rohan Muppa. All rights reserved.
 * Licensed under AGPL-3.0 — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient } from "../api/index.js";
import { CreateModuleSchema, CreateLinkTopicSchema } from "./schemas.js";
import { toolResponse, sanitizeError } from "./tool-helpers.js";
import { log } from "../utils/logger.js";

/**
 * Register content management tools (Faculty features)
 */
export function registerManageContent(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  /**
   * create_module: Create a new content module
   */
  server.registerTool(
    "create_module",
    {
      title: "Create Content Module",
      description:
        "Create a new content module in a course. Use this to organize course materials into sections (e.g., 'Week 1', 'Final Project'). If parentModuleId is provided, creates a sub-module.",
      inputSchema: CreateModuleSchema,
    },
    async (args: any) => {
      try {
        log("INFO", "create_module tool called", { args });
        const { courseId, title, description, parentModuleId, isHidden } = CreateModuleSchema.parse(args);

        const moduleData = {
          Title: title,
          ShortTitle: title.substring(0, 50),
          Description: {
            Text: description ? description.replace(/<[^>]*>?/gm, "") : "",
            Html: description ? (description.includes("<") ? description : `<p>${description}</p>`) : ""
          },
          IsHidden: isHidden,
          IsLocked: false,
          ModuleStartDate: null,
          ModuleEndDate: null,
          ModuleDueDate: null,
        };

        log("INFO", `Sending moduleData to D2L (JSON, 1.57, Comprehensive): ${JSON.stringify(moduleData)}`);

        // Use LE 1.57
        const path = parentModuleId 
          ? `/d2l/api/le/1.57/${courseId}/content/modules/${parentModuleId}/structure/`
          : `/d2l/api/le/1.57/${courseId}/content/root/`;

        const result = await apiClient.post<any>(path, moduleData);

        log("INFO", `create_module: Successfully created module "${title}" (ID: ${result.Id})`);

        return toolResponse({
          success: true,
          moduleId: result.Id,
          title: result.Title,
          courseId: courseId,
          url: `${apiClient.baseUrl}/d2l/le/content/${courseId}/Home?itemIdentifier=${result.Id}`,
        });
      } catch (error) {
        log("ERROR", "create_module failed", error);
        return sanitizeError(error);
      }
    }
  );

  /**
   * create_link_topic: Add a URL/Link to a module
   */
  server.registerTool(
    "create_link_topic",
    {
      title: "Create Link Topic",
      description:
        "Add a web link (URL) to a specific content module. Use this when the instructor wants to share an external resource, video, or website with the class.",
      inputSchema: CreateLinkTopicSchema,
    },
    async (args: any) => {
      try {
        log("INFO", "create_link_topic tool called", { args });
        const { courseId, moduleId, title, url, description, isHidden } = CreateLinkTopicSchema.parse(args);

        const topicData = {
          Title: title,
          ShortTitle: title.substring(0, 50),
          Type: 1, // 1 = Topic
          TopicType: 3, // 3 = Link/URL
          Url: url,
          Description: description ? {
            Text: description.replace(/<[^>]*>?/gm, ""),
            Html: description.includes("<") ? description : `<p>${description}</p>`
          } : { Text: "", Html: "" },
          IsHidden: isHidden,
          IsLocked: false,
          StartDate: null,
          EndDate: null,
          DueDate: null,
        };

        log("INFO", `Sending topicData to D2L (JSON, 1.57, Mirror): ${JSON.stringify(topicData)}`);

        const path = `/d2l/api/le/1.57/${courseId}/content/modules/${moduleId}/structure/`;
        const result = await apiClient.post<any>(path, topicData);

        log("INFO", `create_link_topic: Successfully added link "${title}" to module ${moduleId}`);

        return toolResponse({
          success: true,
          topicId: result.Id,
          title: result.Title,
          url: result.Url,
          courseId: courseId,
        });
      } catch (error) {
        log("ERROR", "create_link_topic failed", error);
        return sanitizeError(error);
      }
    }
  );
}

/**
 * Brightspace MCP Server
 * Copyright (c) 2025 Rohan Muppa. All rights reserved.
 * Licensed under AGPL-3.0 — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient } from "../api/index.js";
import { BulkCourseContentSchema, CreateModuleSchema, CreateLinkTopicSchema } from "./schemas.js";
import { toolResponse, sanitizeError } from "./tool-helpers.js";
import { log } from "../utils/logger.js";

export function buildBulkCourseContentPlan(input: {
  courseId: number;
  modules: Array<{
    title: string;
    description?: string;
    isHidden?: boolean;
    items?: Array<{
      type?: "link" | "html" | "file";
      title: string;
      url?: string;
      content?: string;
      description?: string;
      isHidden?: boolean;
    }>;
  }>;
}): Array<{
  title: string;
  description?: string;
  isHidden: boolean;
  items: Array<{
    type: "link" | "html" | "file";
    title: string;
    url?: string;
    content?: string;
    description?: string;
    isHidden: boolean;
  }>;
}> {
  return input.modules.map((module) => ({
    title: module.title,
    description: module.description,
    isHidden: Boolean(module.isHidden ?? false),
    items: (module.items ?? []).map((item) => ({
      type: item.type ?? "link",
      title: item.title,
      url: item.url,
      content: item.content,
      description: item.description,
      isHidden: Boolean(item.isHidden ?? false),
    })),
  }));
}

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

  /**
   * create_bulk_course_content: Create a set of module scaffolds and link items.
   * This is intentionally conservative: it supports the high-value semester-start flow
   * of creating modules and link topics in one pass, while leaving file uploads for a
   * follow-up implementation.
   */
  server.registerTool(
    "create_bulk_course_content",
    {
      title: "Create Bulk Course Content",
      description:
        "Create a semester-start module scaffolding in bulk. For now this supports modules with link-based items, which is ideal for creating a week-by-week structure with readings, links, and resources.",
      inputSchema: BulkCourseContentSchema,
    },
    async (args: any) => {
      try {
        log("INFO", "create_bulk_course_content tool called", { args });
        const { courseId, modules } = BulkCourseContentSchema.parse(args);
        const plan = buildBulkCourseContentPlan({ courseId, modules });

        const createdModules: Array<{ moduleId: number; title: string; items: Array<{ title: string; type: string; status: string }> }> = [];

        for (const module of plan) {
          const moduleData = {
            Title: module.title,
            ShortTitle: module.title.substring(0, 50),
            Description: module.description ? {
              Text: module.description.replace(/<[^>]*>?/gm, ""),
              Html: module.description.includes("<") ? module.description : `<p>${module.description}</p>`,
            } : { Text: "", Html: "" },
            IsHidden: module.isHidden,
            IsLocked: false,
            ModuleStartDate: null,
            ModuleEndDate: null,
            ModuleDueDate: null,
          };

          const modulePath = `/d2l/api/le/1.57/${courseId}/content/root/`;
          const createdModule = await apiClient.post<any>(modulePath, moduleData);

          const createdItems: Array<{ title: string; type: string; status: string }> = [];

          for (const item of module.items) {
            if (item.type !== "link") {
              createdItems.push({ title: item.title, type: item.type, status: "skipped-not-yet-supported" });
              continue;
            }

            if (!item.url) {
              throw new Error(`A link item titled "${item.title}" is missing a URL.`);
            }

            const topicData = {
              Title: item.title,
              ShortTitle: item.title.substring(0, 50),
              Type: 1,
              TopicType: 3,
              Url: item.url,
              Description: item.description ? {
                Text: item.description.replace(/<[^>]*>?/gm, ""),
                Html: item.description.includes("<") ? item.description : `<p>${item.description}</p>`,
              } : { Text: "", Html: "" },
              IsHidden: item.isHidden,
              IsLocked: false,
              StartDate: null,
              EndDate: null,
              DueDate: null,
            };

            const topicPath = `/d2l/api/le/1.57/${courseId}/content/modules/${createdModule.Id}/structure/`;
            await apiClient.post<any>(topicPath, topicData);

            createdItems.push({ title: item.title, type: item.type, status: "created" });
          }

          createdModules.push({
            moduleId: createdModule.Id,
            title: createdModule.Title,
            items: createdItems,
          });
        }

        return toolResponse({
          success: true,
          courseId,
          modulesCreated: createdModules.length,
          createdModules,
        });
      } catch (error) {
        log("ERROR", "create_bulk_course_content failed", error);
        return sanitizeError(error);
      }
    }
  );
}

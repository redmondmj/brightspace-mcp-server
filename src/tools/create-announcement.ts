/**
 * Brightspace MCP Server
 * Copyright (c) 2025 Rohan Muppa. All rights reserved.
 * Licensed under AGPL-3.0 — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient } from "../api/index.js";
import { CreateAnnouncementSchema } from "./schemas.js";
import { toolResponse, sanitizeError } from "./tool-helpers.js";
import { log } from "../utils/logger.js";

/**
 * Register create_announcement tool (Faculty feature)
 */
export function registerCreateAnnouncement(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "create_announcement",
    {
      title: "Create Announcement",
      description:
        "Create a new announcement (news item) in a specific course. Only works if you have instructor or TA permissions in that course. Use this when the user (faculty/instructor) wants to post a new update, announcement, or message to the class.",
      inputSchema: CreateAnnouncementSchema,
    },
    async (args: any) => {
      try {
        log("INFO", "create_announcement tool called", { args });

        // Parse and validate input
        const { courseId, title, content, isPublished, isPinned } = CreateAnnouncementSchema.parse(args);

        // Prepare D2L NewsItemData object mirroring the GET structure
        const newsItemData = {
          Title: title,
          Body: {
            Text: content.replace(/<[^>]*>?/gm, ""), 
            Html: content.includes("<") ? content : `<p>${content}</p>`,
          },
          StartDate: new Date().toISOString().split(".")[0] + ".000Z",
          EndDate: null,
          IsGlobal: false,
          IsPublished: isPublished,
          ShowOnlyInCourseOfferings: false,
          IsAuthorInfoShown: true,
        };

        log("INFO", `Sending newsItemData to D2L (JSON, 1.57, Mirror): ${JSON.stringify(newsItemData)}`);

        // Use LE 1.57
        const path = `/d2l/api/le/1.57/${courseId}/news/`;
        const result = await apiClient.post<any>(path, newsItemData);

        log("INFO", `D2L response: ${JSON.stringify(result)}`);

        log("INFO", `create_announcement: Successfully created announcement "${title}" (ID: ${result.Id}) in course ${courseId}`);

        return toolResponse({
          success: true,
          announcementId: result.Id,
          title: result.Title,
          courseId: courseId,
          url: `${apiClient.baseUrl}/d2l/le/news/${courseId}/${result.Id}/view`,
        });
      } catch (error) {
        log("ERROR", "create_announcement failed", error);
        return sanitizeError(error);
      }
    }
  );
}

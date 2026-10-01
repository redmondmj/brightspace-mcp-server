import { describe, expect, it } from "vitest";
import { buildBulkCourseContentPlan } from "../../src/tools/manage-content.js";

describe("buildBulkCourseContentPlan", () => {
  it("normalizes module and item definitions into a deterministic bulk plan", () => {
    const plan = buildBulkCourseContentPlan({
      courseId: 123,
      modules: [
        {
          title: "Week 1",
          description: "Intro module",
          isHidden: false,
          items: [
            {
              type: "link",
              title: "Course site",
              url: "https://example.com",
              isHidden: false,
            },
          ],
        },
        {
          title: "Week 2",
          items: [
            {
              type: "link",
              title: "Lecture notes",
              url: "https://example.com/notes",
            },
          ],
        },
      ],
    });

    expect(plan).toEqual([
      {
        title: "Week 1",
        description: "Intro module",
        isHidden: false,
        items: [
          {
            type: "link",
            title: "Course site",
            url: "https://example.com",
            isHidden: false,
          },
        ],
      },
      {
        title: "Week 2",
        description: undefined,
        isHidden: false,
        items: [
          {
            type: "link",
            title: "Lecture notes",
            url: "https://example.com/notes",
            isHidden: false,
          },
        ],
      },
    ]);
  });
});

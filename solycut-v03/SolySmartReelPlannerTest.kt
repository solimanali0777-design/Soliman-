package com.novacut.editor.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SolySmartReelPlannerTest {
    private fun window(clip: Int, part: Int, duration: Long = 3_000L, score: Float = .8f) =
        AutoEditWindow(
            id = "w-$clip-$part",
            clipId = "clip-$clip",
            clipFingerprint = "fingerprint-$clip",
            sourceOrder = clip,
            sourceStartMs = part * duration,
            sourceEndMs = (part + 1) * duration,
            scores = AutoEditScoreComponents(score, score, score, 0f)
        )

    @Test fun reel_uses_all_five_sources_for_exact_thirty_seconds_without_gaps() {
        val windows = (0 until 5).flatMap { clip -> (0 until 2).map { part -> window(clip, part) } }
        val plan = SolySmartReelPlanner.plan(windows)
        assertEquals(30_000L, plan.plannedDurationMs)
        assertEquals(5, plan.segments.map { it.clipId }.distinct().size)
        assertEquals(0L, plan.segments.first().timelineStartMs)
        assertEquals(30_000L, plan.segments.last().timelineEndMs)
        assertTrue(plan.segments.zipWithNext().all { (a, b) -> a.timelineEndMs == b.timelineStartMs })
    }

    @Test fun fails_closed_when_fewer_than_five_distinct_clips() {
        val result = SolySmartReelPlanner.plan((0 until 4).flatMap { clip ->
            (0 until 3).map { part -> window(clip, part) }
        })
        assertTrue(result.segments.isEmpty())
        assertTrue(AutoEditPlanWarning.NO_USABLE_WINDOWS in result.warnings)
    }

    @Test fun fails_closed_when_sources_have_less_than_thirty_seconds_total() {
        val plan = SolySmartReelPlanner.plan((0 until 5).map { window(it, 0) })
        assertTrue(plan.segments.isEmpty())
        assertTrue(AutoEditPlanWarning.TARGET_UNDERFILLED in plan.warnings)
    }

    @Test fun same_input_in_any_order_produces_same_plan() {
        val windows = (0 until 5).flatMap { clip -> (0 until 2).map { part -> window(clip, part) } }
        assertEquals(SolySmartReelPlanner.plan(windows), SolySmartReelPlanner.plan(windows.reversed()))
    }
}

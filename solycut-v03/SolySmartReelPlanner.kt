package com.novacut.editor.ai

/** Deterministic, review-first 30-second reel. No destructive operations or fake padding. */
object SolySmartReelPlanner {
    const val TARGET_DURATION_MS = 30_000L
    const val REQUIRED_DISTINCT_SOURCES = 5

    fun plan(windows: List<AutoEditWindow>): AutoEditPlan {
        val sourceGroups = windows.groupBy { it.clipId }.values
            .sortedWith(
                compareBy<List<AutoEditWindow>> { group -> group.minOf { it.sourceOrder } }
                    .thenBy { group -> group.first().clipId }
            )
        if (sourceGroups.size < REQUIRED_DISTINCT_SOURCES) {
            return unavailable(AutoEditPlanWarning.NO_USABLE_WINDOWS)
        }

        // Guarantee that each input source gets an opportunity before any
        // source receives its second cut; scoring only breaks ties inside a source.
        val bestFirst = sourceGroups.map { clips ->
            clips.sortedWith(
                compareByDescending<AutoEditWindow> { quality(it) }
                    .thenBy { it.sourceStartMs }
                    .thenBy { it.id }
            ).first()
        }
        val chosenIds = bestFirst.map { it.id }.toSet()
        val remainder = windows.asSequence()
            .filterNot { it.id in chosenIds }
            .sortedWith(
                compareByDescending<AutoEditWindow> { quality(it) }
                    .thenBy { it.sourceOrder }
                    .thenBy { it.sourceStartMs }
                    .thenBy { it.id }
            ).toList()

        // The stock SOURCE_ORDER planner is already safe against source-window
        // overlaps and produces gap-free adjacent segments. We control only
        // ordering here, reusing its verified timeline contract.
        val priority = (bestFirst + remainder)
            .mapIndexed { index, window -> window.copy(sourceOrder = index) }
        val proposed = AutoEditPlanner().plan(
            AutoEditPlanRequest(
                windows = priority,
                targetDurationMs = TARGET_DURATION_MS,
                intent = AutoEditIntent.SOURCE_ORDER,
                maxOutputDurationMs = TARGET_DURATION_MS
            )
        )
        val sourceCount = proposed.segments.map { it.clipId }.distinct().size
        if (proposed.plannedDurationMs != TARGET_DURATION_MS ||
            sourceCount < REQUIRED_DISTINCT_SOURCES
        ) {
            return unavailable(AutoEditPlanWarning.TARGET_UNDERFILLED)
        }

        return proposed.copy(intent = AutoEditIntent.HIGHLIGHT_REEL)
    }

    private fun quality(window: AutoEditWindow): Float =
        0.5f * window.scores.visualQuality +
            0.25f * window.scores.motion +
            0.25f * window.scores.subjectPresence

    private fun unavailable(warning: AutoEditPlanWarning) = AutoEditPlan(
        requestedDurationMs = TARGET_DURATION_MS,
        plannedDurationMs = 0L,
        intent = AutoEditIntent.HIGHLIGHT_REEL,
        segments = emptyList(),
        beatSupport = AutoEditBeatSupport.NOT_REQUESTED,
        warnings = listOf(warning),
        confidence = 0f
    )
}

#!/usr/bin/env python3
"""Apply Soly Smart Reel feature to pinned ClearCut source, fail-fast on drift."""
from pathlib import Path
import sys
root = Path(sys.argv[1])
asset_dir = Path(sys.argv[2])
def patch(relative, before, after):
    path = root / relative
    s = path.read_text(encoding="utf-8")
    count = s.count(before)
    if count != 1:
        raise RuntimeError(f"Expected one anchor in {relative}, found {count}: {before[:90]!r}")
    path.write_text(s.replace(before, after, 1), encoding="utf-8")

p = "app/src/main/java/com/novacut/editor/"
planner_dest = root / p / "ai/SolySmartReelPlanner.kt"
planner_dest.write_text((asset_dir / "SolySmartReelPlanner.kt").read_text(encoding="utf-8"), encoding="utf-8")
# Analyzer: reuse the real scored source windows; no simulated AI scores.
patch(p+"ai/AiFeatures.kt",
    "intent: AutoEditIntent = AutoEditIntent.HIGHLIGHT_REEL,\n        onProgress: (Float) -> Unit = {}\n    ): AutoEditResult",
    "intent: AutoEditIntent = AutoEditIntent.HIGHLIGHT_REEL,\n        onProgress: (Float) -> Unit = {},\n        smartReel: Boolean = false\n    ): AutoEditResult")
patch(p+"ai/AiFeatures.kt",
    "val plan = AutoEditPlanner().plan(\n            AutoEditPlanRequest(",
    "val plan = if (smartReel) SolySmartReelPlanner.plan(windows) else AutoEditPlanner().plan(\n            AutoEditPlanRequest(")
# ViewModel: entry point, hard gate, provenance, project/export 9:16 25fps.
vm=p+"ui/editor/EditorViewModel.kt"
patch(vm, "    private var autoEditJob: Job? = null", "    private var solyReelProposalReady = false\n    private var autoEditJob: Job? = null")
patch(vm,
    "    fun showAutoEdit() = showPanel(PanelId.AUTO_EDIT)",
    "    fun showAutoEdit() = showPanel(PanelId.AUTO_EDIT)\n    fun runSolySmartReel() = runAutoEdit(\n        intent = AutoEditIntent.HIGHLIGHT_REEL,\n        targetDurationMs = 30_000L,\n        smartReel = true\n    )")
patch(vm,
    "        targetDurationMs: Long = 60_000L\n    ) {\n        val clips = _state.value.tracks",
    "        targetDurationMs: Long = 60_000L,\n        smartReel: Boolean = false\n    ) {\n        val clips = _state.value.tracks")
patch(vm,
    "        if (clips.isEmpty()) { showToast(text(R.string.vm_add_video_clips_first_toast)); return }\n\n        autoEditJob?.cancel()",
    "        if (clips.isEmpty()) { showToast(text(R.string.vm_add_video_clips_first_toast)); return }\n        if (smartReel && clips.map { it.sourceUri }.distinct().size < 5) {\n            showToast(text(R.string.soly_reel_need_five))\n            return\n        }\n        solyReelProposalReady = false\n\n        autoEditJob?.cancel()")
patch(vm,
    "                    intent = intent\n                )\n\n                if (result.segments.isNotEmpty())",
    "                    intent = intent,\n                    smartReel = smartReel\n                )\n\n                if (result.segments.isNotEmpty())")
patch(vm,
    "                    if (generationId == autoEditGenerationId) {\n                        _state.update {\n                            it.copyAi { ai -> ai.copy(isAutoEditing = false, autoEditProposal = result) }\n                        }",
    "                    if (generationId == autoEditGenerationId) {\n                        solyReelProposalReady = smartReel\n                        _state.update {\n                            it.copyAi { ai -> ai.copy(isAutoEditing = false, autoEditProposal = result) }\n                        }")
patch(vm,
    "                        showToast(text(R.string.vm_auto_edit_failed_toast))",
    "                        showToast(text(if (smartReel) R.string.soly_reel_underfilled else R.string.vm_auto_edit_failed_toast))")
patch(vm,
    "    fun cancelAutoEdit() {\n        autoEditGenerationId++",
    "    fun cancelAutoEdit() {\n        solyReelProposalReady = false\n        autoEditGenerationId++")
patch(vm,
    "        val proposal = snapshot.autoEditProposal ?: return\n        val sourceClips",
    "        val proposal = snapshot.autoEditProposal ?: return\n        val isSolyReel = solyReelProposalReady\n        if (isSolyReel && (proposal.plannedDurationMs != 30_000L ||\n            proposal.segments.map { it.clipId }.distinct().size < 5)) {\n            showToast(text(R.string.soly_reel_underfilled))\n            return\n        }\n        val sourceClips")
patch(vm,
    "            recalculateDuration(\n                state.copy(\n                    tracks = state.tracks.map { track ->",
    """            recalculateDuration(
                state.copy(
                    project = if (isSolyReel) state.project.copy(
                        aspectRatio = AspectRatio.RATIO_9_16,
                        frameRate = 25,
                        frameRateNumerator = 25,
                        frameRateDenominator = 1,
                        resolution = Resolution.FHD_1080P
                    ) else state.project,
                    export = if (isSolyReel) state.export.copy(
                        config = state.exportConfig.copy(
                            resolution = Resolution.FHD_1080P,
                            aspectRatio = AspectRatio.RATIO_9_16,
                            frameRate = 25,
                            forceConstantFrameRate = true,
                            platformPreset = null,
                            timelineRange = TimelineExportRange(0L, 750L)
                        )
                    ) else state.export,
                    tracks = state.tracks.map { track ->""")
patch(vm,
    "        showToast(text(R.string.vm_auto_edit_created_toast, newClips.size))\n        hidePanel(PanelId.AUTO_EDIT)",
    "        solyReelProposalReady = false\n        showToast(text(R.string.vm_auto_edit_created_toast, newClips.size))\n        hidePanel(PanelId.AUTO_EDIT)")
# Add native Smart Reel UI button to stock review-first panel.
panel=p+"ui/editor/AutoEditPanel.kt"
patch(panel,
    "    onGenerate: (AutoEditIntent, Long) -> Unit,\n    onCancel:",
    "    onGenerate: (AutoEditIntent, Long) -> Unit,\n    onSolyReel: () -> Unit,\n    onCancel:")
patch(panel,
    "        Spacer(modifier = Modifier.height(12.dp))\n\n        PremiumPanelCard(accent = ClearCutAccents.Blue)",
    """        if (proposal == null) {
            Spacer(modifier = Modifier.height(12.dp))
            PremiumPanelCard(accent = ClearCutAccents.Green) {
                Text(
                    text = stringResource(R.string.soly_reel_title),
                    style = MaterialTheme.typography.titleMedium,
                    color = semanticColors.text
                )
                Text(
                    text = stringResource(R.string.soly_reel_details),
                    style = MaterialTheme.typography.bodyMedium,
                    color = semanticColors.subtext
                )
                Button(
                    onClick = onSolyReel,
                    enabled = clipCount >= 5 && !isProcessing,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(Icons.Default.AutoFixHigh, contentDescription = null)
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(stringResource(R.string.soly_reel_button))
                }
                if (clipCount < 5) {
                    Text(
                        text = stringResource(R.string.soly_reel_need_five),
                        style = MaterialTheme.typography.bodySmall,
                        color = ClearCutAccents.Peach
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        PremiumPanelCard(accent = ClearCutAccents.Blue)""")
host=p+"ui/editor/EditorUtilityPanelHost.kt"
patch(host,
    "            onGenerate = viewModel::runAutoEdit,\n            onCancel",
    "            onGenerate = { intent, duration -> viewModel.runAutoEdit(intent, duration) },\n            onSolyReel = viewModel::runSolySmartReel,\n            onCancel")
for locale in ("values", "values-es"):
    dest = root / f"app/src/main/res/{locale}/strings.xml"
    strings = {
        "soly_reel_title":"Soly Smart Reel | 30s",
        "soly_reel_details":"Analyzes five or more different videos, proposes gap-free 30-second cuts, keeps existing music and overlays, then lets you edit the timeline before exporting a 9:16 1080p/25fps reel.",
        "soly_reel_button":"Create a 30s Smart Reel",
        "soly_reel_need_five":"Add at least five different video files before creating a Smart Reel.",
        "soly_reel_underfilled":"Not enough usable footage for an exact 30-second reel. No clips were changed."
    }
    import xml.sax.saxutils as xmlutils
    safe = "".join("    <string name=\"%s\">%s</string>\n" % (k, xmlutils.escape(v)) for k,v in strings.items())
    s = dest.read_text(encoding="utf-8")
    if s.count("</resources>") != 1: raise RuntimeError(f"Expected one resources terminator: {dest}")
    dest.write_text(s.replace("</resources>", safe+"</resources>", 1), encoding="utf-8")
print("Soly Smart Reel source patch applied to pinned upstream")

---
status: done
priority: p1
issue_id: "020"
tags: [code-review, frontend, races]
dependencies: []
---

# Memory View: pointerleave Handler Never Fires, Slider State Stuck Forever

## Problem Statement

The `pointerleave` handler on `#memory-cards` is supposed to reset container state from `'adjusting'` to `'idle'` when the user drags outside the slider. But `pointerleave` on a parent fires when the pointer leaves the parent element, not when it leaves a child slider. Since the pointer is still inside `#memory-cards`, this handler never fires. The container state gets stuck at `'adjusting'` permanently, blocking all future SSE renders for that card.

## Findings

**Source**: julik-frontend-races-reviewer (CRITICAL)

**Location**: `/workspace/project/static/dashboard.html` lines 1782-1790

```javascript
cardsEl.onpointerleave = function(e) {
    var slider = e.target.closest('input[type="range"]');
    if (slider) {
        var cid = slider.dataset.containerId;
        if (cid && memoryContainerStates[cid] === 'adjusting') {
            memoryContainerStates[cid] = 'idle';
        }
    }
};
```

Additionally, during browser pointer capture (applied to range inputs during drag), `pointerleave` on ancestors may not fire at all.

**Secondary issue**: After `applyMemoryChanges` completes, no explicit card re-render happens. Cards show stale data until the next SSE message.

## Proposed Solutions

### Option 1: Global pointerup safety net (Recommended)

```javascript
document.addEventListener('pointerup', function() {
    var ids = Object.keys(memoryContainerStates);
    for (var i = 0; i < ids.length; i++) {
        if (memoryContainerStates[ids[i]] === 'adjusting') {
            memoryContainerStates[ids[i]] = 'idle';
        }
    }
});
```

Remove the buggy `pointerleave` handler. Add `fetchMemoryContainers()` call after apply completes.

- Pros: Catches all drag-end scenarios including pointer leaving browser window
- Cons: Handler persists across view navigations (needs cleanup tracking)
- Effort: Small
- Risk: Low

## Acceptance Criteria

- [x] Container state resets to 'idle' when user releases slider anywhere
- [x] Stale pointerleave handler removed
- [x] Cards re-render immediately after apply completes (explicit fetch)
- [x] No container card permanently stuck showing stale data

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-11 | Created from code review | julik-frontend-races-reviewer flagged as CRITICAL |
| 2026-02-11 | Fixed | Replaced buggy onpointerleave with global pointerup listener; added fetchMemoryContainers() after applyMemoryChanges completes |

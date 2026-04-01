package com.evalops.composer.toolwindow

import com.evalops.composer.api.AgentEvent

fun formatRuntimeStatus(event: AgentEvent): String? {
    return when (event) {
        is AgentEvent.Status -> {
            if (event.status.isBlank()) {
                null
            } else if (event.status == "compacting") {
                "Compacting conversation..."
            } else {
                "Status: ${event.status}"
            }
        }
        is AgentEvent.Compaction -> {
            if (event.auto == true) {
                "Compacted conversation automatically"
            } else {
                "Compacted conversation"
            }
        }
        else -> null
    }
}

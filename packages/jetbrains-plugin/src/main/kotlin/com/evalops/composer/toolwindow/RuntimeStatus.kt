package com.evalops.composer.toolwindow

import com.evalops.composer.api.AgentEvent

fun formatRuntimeStatus(event: AgentEvent): String? {
    return when (event) {
        is AgentEvent.Status -> {
            val status = event.status.trim()
            if (status.isEmpty()) {
                null
            } else if (status == "compacting") {
                "Compacting conversation..."
            } else {
                "Status: $status"
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

package com.evalops.composer.actions

import com.evalops.composer.services.ComposerProjectService
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.project.DumbAware

/**
 * Action to add a file to the Composer context.
 */
class AddToContextAction : AnAction(), DumbAware {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE) ?: return

        val service = ComposerProjectService.getInstance(project)
        service.pinFile(file.path)

        // Show notification
        com.intellij.notification.NotificationGroupManager.getInstance()
            .getNotificationGroup("Composer Notifications")
            .createNotification(
                "Added to Context",
                "File '${file.name}' added to Composer context.",
                com.intellij.notification.NotificationType.INFORMATION
            )
            .notify(project)
    }

    override fun update(e: AnActionEvent) {
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
        e.presentation.isEnabledAndVisible = file != null && !file.isDirectory
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT
}

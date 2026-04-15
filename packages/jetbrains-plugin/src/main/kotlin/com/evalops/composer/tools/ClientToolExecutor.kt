package com.evalops.composer.tools

import com.evalops.composer.api.DiagnosticInfo
import com.evalops.composer.api.DiagnosticPosition
import com.evalops.composer.api.DiagnosticRange
import com.evalops.composer.api.LocationInfo
import com.google.gson.Gson
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectRootManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiManager
import com.intellij.psi.PsiNamedElement
import com.intellij.psi.search.searches.ReferencesSearch
import java.io.File

/**
 * Executor for client-side tools that use IDE APIs (PSI, diagnostics, etc.)
 */
class ClientToolExecutor(private val project: Project) {

    private val logger = Logger.getInstance(ClientToolExecutor::class.java)
    private val gson = Gson()
    private val diagnosticsUnavailableLogged = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * Execute a client tool by name.
     */
    fun execute(toolName: String, args: Map<String, Any?>): String {
        return when (toolName) {
            "jetbrains_get_diagnostics" -> getDiagnostics(args["uri"] as? String)
            "jetbrains_get_definition" -> getDefinition(
                args["uri"] as? String ?: throw IllegalArgumentException("uri required"),
                (args["line"] as? Number)?.toInt() ?: throw IllegalArgumentException("line required"),
                (args["character"] as? Number)?.toInt() ?: throw IllegalArgumentException("character required")
            )
            "jetbrains_find_references" -> findReferences(
                args["uri"] as? String ?: throw IllegalArgumentException("uri required"),
                (args["line"] as? Number)?.toInt() ?: throw IllegalArgumentException("line required"),
                (args["character"] as? Number)?.toInt() ?: throw IllegalArgumentException("character required")
            )
            "jetbrains_read_file_range" -> readFileRange(
                args["uri"] as? String ?: throw IllegalArgumentException("uri required"),
                (args["startLine"] as? Number)?.toInt() ?: throw IllegalArgumentException("startLine required"),
                (args["endLine"] as? Number)?.toInt() ?: throw IllegalArgumentException("endLine required")
            )
            else -> throw IllegalArgumentException("Unknown client tool: $toolName")
        }
    }

    /**
     * Get diagnostics (errors/warnings) for a file or all open files.
     */
    private fun getDiagnostics(filePath: String?): String {
        return ReadAction.compute<String, Throwable> {
            val diagnostics = mutableListOf<DiagnosticInfo>()
            val psiManager = PsiManager.getInstance(project)
            val documentManager = FileDocumentManager.getInstance()

            val files: List<VirtualFile> = if (filePath != null) {
                val vf = findVirtualFile(filePath)
                if (vf != null) listOf(vf) else emptyList()
            } else {
                // Get all open editor files
                FileEditorManager.getInstance(project).openFiles.toList()
            }

            for (file in files) {
                val psiFile = psiManager.findFile(file) ?: continue
                val document = documentManager.getDocument(file) ?: continue

                // Use reflection to avoid direct dependency on internal daemon APIs.
                val highlights = getDaemonHighlights(document)
                for (info in highlights) {
                    val diagnostic = toDiagnostic(info, document)
                    if (diagnostic != null) {
                        diagnostics.add(diagnostic)
                    }
                }
            }

            gson.toJson(diagnostics)
        }
    }

    /**
     * Go to definition of a symbol at a specific position.
     */
    private fun getDefinition(filePath: String, line: Int, character: Int): String {
        return ReadAction.compute<String, Throwable> {
            val vf = findVirtualFile(filePath)
                ?: return@compute gson.toJson(emptyList<LocationInfo>())

            val psiFile = PsiManager.getInstance(project).findFile(vf)
                ?: return@compute gson.toJson(emptyList<LocationInfo>())

            val document = FileDocumentManager.getInstance().getDocument(vf)
                ?: return@compute gson.toJson(emptyList<LocationInfo>())

            val offset = getOffset(document, line, character)
            val element = psiFile.findElementAt(offset)
                ?: return@compute gson.toJson(emptyList<LocationInfo>())

            val definitions = mutableListOf<LocationInfo>()

            // Try to resolve reference
            val reference = element.reference
            val resolved = reference?.resolve()

            if (resolved != null) {
                addLocation(resolved, definitions)
            } else {
                // Try parent elements for broader context
                var parent: PsiElement? = element.parent
                var attempts = 0
                while (parent != null && attempts < 5) {
                    val parentRef = parent.reference
                    val parentResolved = parentRef?.resolve()
                    if (parentResolved != null) {
                        addLocation(parentResolved, definitions)
                        break
                    }
                    parent = parent.parent
                    attempts++
                }
            }

            gson.toJson(definitions)
        }
    }

    /**
     * Find all references to a symbol at a specific position.
     */
    private fun findReferences(filePath: String, line: Int, character: Int): String {
        return ReadAction.compute<String, Throwable> {
            val vf = findVirtualFile(filePath)
                ?: return@compute gson.toJson(emptyList<LocationInfo>())

            val psiFile = PsiManager.getInstance(project).findFile(vf)
                ?: return@compute gson.toJson(emptyList<LocationInfo>())

            val document = FileDocumentManager.getInstance().getDocument(vf)
                ?: return@compute gson.toJson(emptyList<LocationInfo>())

            val offset = getOffset(document, line, character)
            val element = psiFile.findElementAt(offset)
                ?: return@compute gson.toJson(emptyList<LocationInfo>())

            val references = mutableListOf<LocationInfo>()

            // Find the declaration/named element
            val namedElement = findNamedElement(element)
            if (namedElement != null) {
                val query = ReferencesSearch.search(namedElement)
                for (ref in query.findAll()) {
                    val refElement = ref.element
                    addLocation(refElement, references)
                }
            }

            gson.toJson(references)
        }
    }

    /**
     * Read a specific range of lines from a file.
     */
    private fun readFileRange(filePath: String, startLine: Int, endLine: Int): String {
        return ReadAction.compute<String, Throwable> {
            val vf = findVirtualFile(filePath)
                ?: return@compute "Error: File not found: $filePath"

            val document = FileDocumentManager.getInstance().getDocument(vf)
                ?: return@compute "Error: Could not get document for file"

            val lineCount = document.lineCount
            val actualStartLine = startLine.coerceAtLeast(0)
            val actualEndLine = (endLine + 1).coerceAtMost(lineCount)

            val result = StringBuilder()
            for (i in actualStartLine until actualEndLine) {
                val lineStart = document.getLineStartOffset(i)
                val lineEnd = document.getLineEndOffset(i)
                result.append(document.getText(com.intellij.openapi.util.TextRange(lineStart, lineEnd)))
                result.append("\n")
            }

            result.toString()
        }
    }

    /**
     * Find a virtual file from a path, checking if it's within the project.
     */
    private fun findVirtualFile(path: String): VirtualFile? {
        // Try absolute path first
        var vf = LocalFileSystem.getInstance().findFileByPath(path)

        // Try relative to project root
        if (vf == null) {
            val projectRoot = project.basePath
            if (projectRoot != null) {
                val absolutePath = File(projectRoot, path).absolutePath
                vf = LocalFileSystem.getInstance().findFileByPath(absolutePath)
            }
        }

        // Validate file is within project (security: reject files outside project)
        if (vf != null) {
            val fileIndex = ProjectRootManager.getInstance(project).fileIndex
            if (!fileIndex.isInContent(vf)) {
                logger.warn("Rejecting file outside project content for security: $path")
                return null
            }
        }

        return vf
    }

    private fun getDaemonHighlights(document: Document): List<Any> {
        val daemonClass = runCatching {
            Class.forName("com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerImpl")
        }.getOrElse { error ->
            logDiagnosticsUnavailable("DaemonCodeAnalyzerImpl unavailable for diagnostics.", error)
            return emptyList()
        }

        val method = daemonClass.methods.firstOrNull { method ->
            method.name == "getHighlights" &&
                method.parameterTypes.size == 3 &&
                Document::class.java.isAssignableFrom(method.parameterTypes[0]) &&
                HighlightSeverity::class.java.isAssignableFrom(method.parameterTypes[1]) &&
                Project::class.java.isAssignableFrom(method.parameterTypes[2])
        } ?: run {
            logDiagnosticsUnavailable("DaemonCodeAnalyzerImpl.getHighlights signature not found.")
            return emptyList()
        }

        val result = runCatching {
            method.invoke(null, document, HighlightSeverity.INFORMATION, project)
        }.getOrElse { error ->
            logDiagnosticsUnavailable("Failed to invoke daemon highlights for diagnostics.", error)
            return emptyList()
        }

        return (result as? List<*>)?.filterNotNull() ?: emptyList()
    }

    private fun toDiagnostic(info: Any, document: Document): DiagnosticInfo? {
        val severity = getHighlightSeverity(info) ?: return null
        if (severity.myVal < HighlightSeverity.WARNING.myVal) {
            return null
        }

        val startOffset = getIntProperty(info, "getStartOffset", "startOffset") ?: return null
        val endOffset = getIntProperty(info, "getEndOffset", "endOffset") ?: return null
        val textLength = document.textLength
        val safeStart = startOffset.coerceIn(0, textLength)
        val safeEnd = endOffset.coerceIn(safeStart, textLength)

        val startLine = document.getLineNumber(safeStart)
        val endLine = document.getLineNumber(safeEnd)
        val startChar = safeStart - document.getLineStartOffset(startLine)
        val endChar = safeEnd - document.getLineStartOffset(endLine)

        val message = getStringProperty(info, "getDescription", "description") ?: "Unknown issue"
        val source = getStringProperty(info, "getInspectionToolId", "inspectionToolId")
        val code = getAnyProperty(info, "getType", "type")?.toString()

        return DiagnosticInfo(
            message = message,
            severity = severity.myVal,
            range = DiagnosticRange(
                start = DiagnosticPosition(startLine, startChar),
                end = DiagnosticPosition(endLine, endChar)
            ),
            source = source,
            code = code
        )
    }

    private fun getHighlightSeverity(info: Any): HighlightSeverity? {
        val value = getAnyProperty(info, "getSeverity", "severity")
        return value as? HighlightSeverity
    }

    private fun getIntProperty(target: Any, vararg names: String): Int? {
        val value = getAnyProperty(target, *names) ?: return null
        return when (value) {
            is Int -> value
            is Number -> value.toInt()
            else -> null
        }
    }

    private fun getStringProperty(target: Any, vararg names: String): String? {
        val value = getAnyProperty(target, *names) ?: return null
        return value as? String
    }

    private fun getAnyProperty(target: Any, vararg names: String): Any? {
        val clazz = target.javaClass
        for (name in names) {
            runCatching {
                return clazz.getMethod(name).invoke(target)
            }
            runCatching {
                val field = clazz.getDeclaredField(name)
                field.isAccessible = true
                return field.get(target)
            }
        }
        return null
    }

    private fun logDiagnosticsUnavailable(message: String, error: Throwable? = null) {
        if (diagnosticsUnavailableLogged.compareAndSet(false, true)) {
            if (error == null) {
                logger.warn(message)
            } else {
                logger.warn(message, error)
            }
        }
    }

    /**
     * Convert line/character to document offset.
     */
    private fun getOffset(document: Document, line: Int, character: Int): Int {
        val actualLine = line.coerceIn(0, document.lineCount - 1)
        val lineStart = document.getLineStartOffset(actualLine)
        val lineEnd = document.getLineEndOffset(actualLine)
        val actualChar = character.coerceIn(0, lineEnd - lineStart)
        return lineStart + actualChar
    }

    /**
     * Add a PSI element's location to the list.
     */
    private fun addLocation(element: PsiElement, locations: MutableList<LocationInfo>) {
        val file = element.containingFile?.virtualFile ?: return
        val document = FileDocumentManager.getInstance().getDocument(file) ?: return

        val startOffset = element.textRange.startOffset
        val endOffset = element.textRange.endOffset
        val startLine = document.getLineNumber(startOffset)
        val endLine = document.getLineNumber(endOffset)
        val startChar = startOffset - document.getLineStartOffset(startLine)
        val endChar = endOffset - document.getLineStartOffset(endLine)

        locations.add(
            LocationInfo(
                uri = file.path,
                range = DiagnosticRange(
                    start = DiagnosticPosition(startLine, startChar),
                    end = DiagnosticPosition(endLine, endChar)
                )
            )
        )
    }

    /**
     * Find the named element containing or referenced by the given element.
     */
    private fun findNamedElement(element: PsiElement): PsiElement? {
        // Try to resolve reference first
        val reference = element.reference
        val resolved = reference?.resolve()
        if (resolved != null) {
            return resolved
        }

        // Walk up to find a named element using proper PSI interface
        var current: PsiElement? = element
        while (current != null) {
            if (current.isValid && current is PsiNamedElement) {
                val name = current.name
                if (!name.isNullOrEmpty()) {
                    return current
                }
            }
            current = current.parent
        }

        return null
    }
}

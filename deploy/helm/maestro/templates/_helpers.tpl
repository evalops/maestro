{{/*
Expand the name of the chart.
*/}}
{{- define "maestro.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "maestro.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "maestro.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "maestro.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "maestro.selectorLabels" -}}
app.kubernetes.io/name: {{ include "maestro.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name
*/}}
{{- define "maestro.serviceAccountName" -}}
{{- if .Values.serviceAccount }}
{{- if .Values.serviceAccount.name }}
{{- .Values.serviceAccount.name }}
{{- else }}
{{- include "maestro.fullname" . }}
{{- end }}
{{- else }}
{{- include "maestro.fullname" . }}
{{- end }}
{{- end }}

{{/*
Validate process-local headless runtime routing before rendering workload
resources. Multi-replica web/headless deployments need sticky sessions or a
durable owner router; otherwise clients can land on a pod that does not own the
runtime state for /api/headless/* or /api/chat/ws.
*/}}
{{- define "maestro.validateHeadlessRuntimeRouting" -}}
{{- $replicas := int (default 1 .Values.replicaCount) -}}
{{- $headlessRuntime := default dict (get .Values "headlessRuntime") -}}
{{- $routing := default dict (get $headlessRuntime "routing") -}}
{{- $routingMode := default "single-replica" (get $routing "mode") -}}
{{- $validModes := list "single-replica" "sticky-session" "durable-owner" -}}
{{- if not (has $routingMode $validModes) -}}
{{- fail (printf "headlessRuntime.routing.mode must be one of %s, got %q" (join ", " $validModes) $routingMode) -}}
{{- end -}}
{{- if and (gt $replicas 1) (eq $routingMode "single-replica") -}}
{{- fail "replicaCount > 1 requires headlessRuntime.routing.mode to be sticky-session or durable-owner so /api/headless/* and /api/chat/ws stay on the owning runtime pod" -}}
{{- end -}}
{{- end }}

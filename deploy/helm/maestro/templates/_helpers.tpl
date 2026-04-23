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
Reject unsafe multi-replica defaults while headless runtime state is in-process.
*/}}
{{- define "maestro.validateHeadlessRuntimeRouting" -}}
{{- $replicas := int (default 1 .Values.replicaCount) -}}
{{- $mode := default "inProcess" .Values.headlessRuntimeRouting.mode -}}
{{- if and (gt $replicas 1) (eq $mode "inProcess") -}}
{{- fail "Maestro headless runtime state is in-process; set replicaCount to 1 or configure durable owner routing before using multiple replicas" -}}
{{- end -}}
{{- end }}

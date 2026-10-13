{{- define "provisioner.labels" -}}
app.kubernetes.io/name: provisioner
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: team-mcp
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "provisioner.selectorLabels" -}}
app.kubernetes.io/name: provisioner
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* The ServiceAccount's username, as the API server sees it (RBAC + admission policy). */}}
{{- define "provisioner.username" -}}
system:serviceaccount:{{ .Release.Namespace }}:provisioner
{{- end -}}

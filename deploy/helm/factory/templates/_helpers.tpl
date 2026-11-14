{{- define "factory.name" -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{- define "factory.labels" -}}
app.kubernetes.io/name: factory
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
{{- end -}}

{{- define "factory.publicURL" -}}
{{- $value := required "Set publicURL to the browser-facing Factory origin" .Values.publicURL -}}
{{- $url := urlParse $value -}}
{{- if or (not (has $url.scheme (list "http" "https"))) (not $url.host) $url.userinfo $url.query $url.fragment (and $url.path (ne $url.path "/")) -}}
{{- fail "publicURL must be an HTTP(S) origin without credentials, query or path" -}}
{{- end -}}
{{- if and (not .Values.development) (ne $url.scheme "https") -}}
{{- fail "Non-development Factory requires an HTTPS publicURL" -}}
{{- end -}}
{{- if and (not .Values.development) (or (regexMatch "^[0-9.]+(:[0-9]+)?$" $url.host) (hasPrefix "[" $url.host)) -}}
{{- fail "Use a DNS hostname for publicURL so isolated runtime wildcard hosts can be routed" -}}
{{- end -}}
{{- if and .Values.development (not (regexMatch "^(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?$" $url.host)) -}}
{{- fail "development is limited to a loopback publicURL" -}}
{{- end -}}
{{- trimSuffix "/" $value -}}
{{- end -}}

{{- define "factory.forgeURL" -}}
{{- $value := required "Set forgejoPublicURL to the browser-facing Forgejo origin" .Values.forgejoPublicURL -}}
{{- $url := urlParse $value -}}
{{- if or (not (has $url.scheme (list "http" "https"))) (not $url.host) $url.userinfo $url.query $url.fragment (and $url.path (ne $url.path "/")) -}}
{{- fail "forgejoPublicURL must be an HTTP(S) origin without credentials, query or path" -}}
{{- end -}}
{{- if ne $url.scheme "https" -}}
{{- fail "Native Factory requires an HTTPS forgejoPublicURL" -}}
{{- end -}}
{{- if or (regexMatch "^[0-9.]+(:[0-9]+)?$" $url.host) (hasPrefix "[" $url.host) (and (contains ":" $url.host) (not (hasSuffix ":443" $url.host))) -}}
{{- fail "Native forgejoPublicURL requires a DNS hostname on TLS port 443" -}}
{{- end -}}
{{- if eq (trimSuffix "/" .Values.publicURL) (trimSuffix "/" $value) -}}
{{- fail "Factory and Forgejo require distinct browser origins" -}}
{{- end -}}
{{- trimSuffix "/" $value -}}
{{- end -}}

{{- define "factory.claim" -}}
accessModes: [ReadWriteOnce]
{{- with .root.Values.storageClass }}
storageClassName: {{ . | quote }}
{{- end }}
resources:
  requests:
    storage: {{ .size | quote }}
{{- end -}}

{{- define "factory.zeroBrowserURL" -}}
{{- $factory := include "factory.publicURL" . -}}
{{- if .Values.development -}}
{{- $value := required "Set developmentZeroURL to the separate loopback planning-cache listener" .Values.developmentZeroURL -}}
{{- $url := urlParse $value -}}
{{- $public := urlParse $factory -}}
{{- if or (ne $url.scheme $public.scheme) $url.userinfo $url.query $url.fragment (and $url.path (ne $url.path "/")) (ne (regexReplaceAll ":[0-9]+$" $url.host "") (regexReplaceAll ":[0-9]+$" $public.host "")) -}}
{{- fail "developmentZeroURL must use the same loopback hostname and scheme as publicURL, without a path or credentials, so session cookies are forwarded" -}}
{{- end -}}
{{- if or (eq $url.host $public.host) (eq (trimSuffix "/" $value) (trimSuffix "/" .Values.forgejoPublicURL)) -}}
{{- fail "developmentZeroURL requires its own forwarded port" -}}
{{- end -}}
{{- printf "%s/zero" (trimSuffix "/" $value) -}}
{{- else -}}
{{- if .Values.developmentZeroURL -}}
{{- fail "developmentZeroURL is only for local port-forwarding; public planning traffic uses publicURL/zero" -}}
{{- end -}}
{{- printf "%s/zero" $factory -}}
{{- end -}}
{{- end -}}

{{- define "factory.image" -}}
{{- $value := required "image is required: set it to the Factory application image reference (an @sha256 digest outside local acceptance)" .Values.image -}}
{{- if and (not .Values.development) (not (regexMatch "^[a-zA-Z0-9.:/_-]+@sha256:[a-f0-9]{64}$" $value)) -}}
{{- fail "Non-development Factory requires an image pinned by @sha256 digest" -}}
{{- end -}}
{{- $value | quote -}}
{{- end -}}

{{- define "factory.credentialsSecret" -}}
{{- default (printf "%s-credentials" (include "factory.name" .)) .Values.existingSecrets.credentials -}}
{{- end -}}

{{- define "factory.objectsSecret" -}}
{{- default (printf "%s-objects" (include "factory.name" .)) .Values.existingSecrets.objects -}}
{{- end -}}

{{- define "factory.openbaoTLSSecret" -}}
{{- default (printf "%s-openbao-tls" (include "factory.name" .)) .Values.existingSecrets.openbaoTLS -}}
{{- end -}}

{{- /*
Pod-template checksum for Secrets the operator owns. It is empty when the chart generates the
Secret (generated values never change) and reads the live Secret through lookup, which
returns nothing under helm template; existingSecrets.revision covers that renderer.
*/ -}}
{{- define "factory.existingSecretChecksum" -}}
{{- $root := .root -}}
{{- $parts := list -}}
{{- range $name := .names -}}
{{- if $name -}}
{{- $secret := lookup "v1" "Secret" $root.Release.Namespace $name -}}
{{- $parts = append $parts (printf "%s=%s" $name (toJson (default (dict) (get $secret "data")))) -}}
{{- end -}}
{{- end -}}
{{- if $parts -}}
{{- append $parts (toString $root.Values.existingSecrets.revision) | join "\n" | sha256sum -}}
{{- end -}}
{{- end -}}

{{- /* Restricted container defaults shared by every chart workload. */ -}}
{{- define "factory.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities: {drop: [ALL]}
seccompProfile: {type: RuntimeDefault}
{{- end -}}

{{- /*
Fresh chart-managed volumes start root-owned. A short root init container hands
them to the service user; it needs only chown and traversal capabilities.
*/ -}}
{{- define "factory.ownVolume" -}}
- name: own-data
  image: {{ .image }}
  command:
    - sh
    - -c
    - find {{ .path }} \( ! -user {{ .uid }} -o ! -group {{ .gid }} \) -exec chown {{ .uid }}:{{ .gid }} {} \;
  securityContext:
    runAsUser: 0
    runAsNonRoot: false
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities: {drop: [ALL], add: [CHOWN, DAC_OVERRIDE, FOWNER]}
    seccompProfile: {type: RuntimeDefault}
  resources:
    requests: {cpu: 10m, memory: 16Mi}
    limits: {cpu: 250m, memory: 64Mi}
  volumeMounts:
    - {name: data, mountPath: {{ .path }}}
{{- end -}}

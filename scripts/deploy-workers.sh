#!/bin/sh
# Deploy all backend consumers from the shared workers/index.js entry point.
set -eu

if [ "$#" -ne 1 ]; then
  printf 'Usage: KUBECONFIG=/path/to/config sh %s BACKEND_IMAGE\n' "$0" >&2
  exit 1
fi

task_image=$1
task_deployment=${WORKER_DEPLOYMENT:-contact-worker}
task_namespace=${WORKER_NAMESPACE:-default}
task_container=${WORKER_CONTAINER:-wa-dashboard}
task_pull_policy=${WORKER_IMAGE_PULL_POLICY:-IfNotPresent}

# These values are inserted into a YAML patch as double-quoted scalars.
case "$task_image" in
  ''|*[!a-zA-Z0-9./:@_-]*) printf 'Invalid backend image reference\n' >&2; exit 1 ;;
esac
case "$task_container" in
  ''|*[!a-zA-Z0-9_-]*) printf 'Invalid container name\n' >&2; exit 1 ;;
esac
case "$task_pull_policy" in
  Always|IfNotPresent|Never) ;;
  *) printf 'Invalid image pull policy\n' >&2; exit 1 ;;
esac

# Fail if the named container is absent rather than accidentally adding a sidecar.
task_containers=$(kubectl get deployment "$task_deployment" -n "$task_namespace" \
  -o jsonpath='{.spec.template.spec.containers[*].name}')
case " $task_containers " in
  *" $task_container "*) ;;
  *) printf 'Container %s is absent from %s; found: %s\n' "$task_container" "$task_deployment" "$task_containers" >&2; exit 1 ;;
esac

task_patch=$(mktemp)
trap 'rm -f -- "$task_patch"' EXIT
trap 'exit 1' HUP INT TERM
cat > "$task_patch" <<EOF
spec:
  template:
    spec:
      containers:
        - name: "$task_container"
          image: "$task_image"
          imagePullPolicy: "$task_pull_policy"
          command: ["npm"]
          args: ["run", "start:worker"]
EOF

kubectl patch deployment "$task_deployment" -n "$task_namespace" \
  --type=strategic --patch-file "$task_patch"
kubectl rollout status "deployment/$task_deployment" -n "$task_namespace" --timeout=120s
kubectl logs "deployment/$task_deployment" -n "$task_namespace" -c "$task_container" --tail=100

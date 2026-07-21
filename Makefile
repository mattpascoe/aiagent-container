.PHONY: build update run run-args pi-role claude-role clean purge shell setup setup-common setup-% usage help logs
.ONESHELL:

# Gather the current users real username and UID/GID so we can use it within the container
export REAL_USER := $(or $(SUDO_USER),$(shell whoami))
export HOST_UID := $(shell id -u $(REAL_USER))
export HOST_GID := $(shell id -g $(REAL_USER))
export COMPOSE_PROJECT_NAME := $(REAL_USER)

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

export PARANOID_MODE ?= true
export WORKDIR ?= .
export SVC ?= pi

# Coms project namespace. Inside every container the cwd is always
# /workspace, so if we let the agent default to `basename(cwd)` every
# agent lands in a project called "workspace" regardless of what host
# directory it is actually working on. Instead we default the project to
# the basename of the host WORKDIR, so agents working on the same host
# directory share a project and can discover each other. Override with
# PROJECT=<name>.
export PROJECT ?= $(notdir $(abspath $(WORKDIR)))


usage:
	@cat <<EOF
	Usage: make [options] [target]
	
	Available targets:
	  build      Build docker container
	  update     Build a fresh container with no cache
	  run        Run the default pi context
	  run-args   Run the container with extra args (args="...")
	  pi-role    Run a pi agent from agent-roles/<ROLE>.md
	  claude-role Run a claude agent from agent-roles/<ROLE>.md
	  shell      Start the container in bash
	  logs       Tail container logs
	  clean      Stop and remove containers
	  purge      Remove containers, images, and named volumes
	  usage      Show this help message
	
	Common options:
	  SVC=claude		The composer service to run (default: pi)
	  WORKDIR=/some/path	The workspace dir to mount into the container (default: .)

	Role options (pi-role / claude-role):
	  ROLE=reviewer		Role file stem: agent-roles/<ROLE>.md (required)
	  MODEL=sonnet		Model pattern passed to --model (optional)
	  PROMPT="do the thing"	One-shot prompt; omit for an interactive session (optional)
	  PROJECT=myproj	Coms project namespace (default: basename of WORKDIR)

	Examples:
	  make SVC=claude WORKDIR=/opt/dev/username run
	  make pi-role ROLE=reviewer
	  make pi-role ROLE=tester MODEL=sonnet PROMPT="run the suite"
	  make claude-role ROLE=reviewer

	EOF

help: usage

setup-common:
	@echo "\033[32mExecuting '\033[34m$(SVC)\033[32m' setup in workspace: \033[34m$(WORKDIR)\033[0m"

# setup must be defined BEFORE the pattern rule
setup: setup-common
	@mkdir -p ~/.$(SVC)
	@chmod 755 ~/.$(SVC)
	@chown -R $(HOST_UID):$(HOST_GID) ~/.$(SVC)
	@mkdir -p ~/.agentharness-comms
	@chmod 755 ~/.agentharness-comms
	@chown -R $(HOST_UID):$(HOST_GID) ~/.agentharness-comms

# generic pattern rule
setup-%: setup
	@true

# special-case override
setup-opencode: setup-common
	@mkdir -p ~/.config/opencode ~/.local/share/opencode ~/.local/state/opencode ~/.cache/opencode
	@chmod 755 ~/.config/opencode ~/.local/share/opencode ~/.local/state/opencode ~/.cache/opencode
	@chown -R $(HOST_UID):$(HOST_GID) ~/.config/opencode ~/.local/share/opencode ~/.local/state/opencode ~/.cache/opencode

build: setup-$(SVC)
	docker compose build $(SVC)

update: setup-$(SVC)
	docker compose build --no-cache $(SVC)

# Using --service-ports so that things like hermes that have services listening inside can expose them to the host.
run: setup-$(SVC)
	docker compose run --service-ports --rm $(SVC)

run-args: setup-$(SVC)
	docker compose run --service-ports --rm $(SVC) $(args)

# Launch an agent from a role file in agent-roles/<ROLE>.md.
# ROLE is required; MODEL and PROMPT are optional.
#   - pi reads the role file's frontmatter to populate its coms identity.
#   - claude ignores the frontmatter (body still loads as the system prompt).
# Extensions are auto-loaded by the pi entrypoint, so no -e is needed.
ROLE_FILE := /workspace/agent-roles/$(ROLE).md
MODEL_ARG := $(if $(MODEL),--model $(MODEL),)

pi-role: setup-pi
	@test -n "$(ROLE)" || { echo "ERROR: ROLE is required (e.g. make pi-role ROLE=reviewer)"; exit 1; }
	docker compose run --service-ports --rm pi \
	  --append-system-prompt $(ROLE_FILE) --project $(PROJECT) $(MODEL_ARG) \
	  $(if $(PROMPT),-p "$(PROMPT)",)

claude-role: setup-claude
	@test -n "$(ROLE)" || { echo "ERROR: ROLE is required (e.g. make claude-role ROLE=reviewer)"; exit 1; }
	docker compose run --service-ports --rm -e AGENTHARNESS_PROJECT=$(PROJECT) claude \
	  --append-system-prompt $(ROLE_FILE) $(MODEL_ARG) \
	  $(if $(PROMPT),--print "$(PROMPT)",)

shell: setup-$(SVC)
	docker compose run --service-ports --rm --entrypoint /bin/bash $(SVC)

logs:
	docker compose logs --tail=100 -f $(SVC)

clean:
	docker compose down $(SVC)

#purge: clean
#	docker compose down --rmi local --volumes

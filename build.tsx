import { GraphQLRequestError, connect } from "@dagger.io/dagger";

const rtx_version = "v2023.10.1";

connect(
  async (client) => {
    // create a cache volume
    const node_cache = client.cacheVolume("node");

    const platform = await client.defaultPlatform();

    const arch = platform.includes("arm64") ? "arm64" : "x64";

    const rtx_image = `${process.env.REGISTRY}/${process.env.IMAGE_NAME}/rtx:${rtx_version}`;

    try {
      await client.container().from(rtx_image).sync();
    } catch (e: unknown) {
      if (isImageNotFoundError(e)) {
        console.log("Image not found");
      }
    }

    return;

    const worker = client
      .container()
      .from("ubuntu")
      .withWorkdir("/wrk")
      .withExec([
        "sh",
        "-c",
        "apt-get update && apt-get install --yes git curl unzip",
      ]);

    const rtx = worker
      .withExec([
        "sh",
        "-c",
        ["apt-get update", "apt-get install -y xz-utils"].join(" && "),
      ])
      .withExec(
        `curl -L https://github.com/jdx/rtx/releases/download/${rtx_version}/rtx-${rtx_version}-linux-${arch}.tar.xz -o rtx.tar.xz`.split(
          /\s+/
        )
      )
      .withExec("tar xvf rtx.tar.xz".split(/\s+/));

    const base = worker.withFile("/usr/local/bin/rtx", rtx.file("rtx/bin/rtx"));

    const base_excludes = ["tmp", "**/node_modules"];

    const source_directory = client
      .host()
      .directory(".", { exclude: [...base_excludes] });

    const builder = base
      .withDirectory(".", source_directory)
      .withExec([
        "sh",
        "-c",
        ["rtx install --yes", "rtx cache clear"].join(" && "),
      ]);

    const diff = await base.directory("/").diff(builder.directory("/"));

    await diff.sync();
    // await diff.export("tmp/builder-diff");

    return;

    // use a node:16-slim container
    // mount the source code directory on the host
    // at /src in the container
    // mount the cache volume to persist dependencies
    const source = client
      .container()
      .from("node:16-slim")
      .withDirectory("/src", client.host().directory("."), {
        exclude: ["node_modules/", "ci/"],
      })
      .withMountedCache("/src/node_modules", node_cache);

    // set the working directory in the container
    // install application dependencies
    const runner = source.withWorkdir("/src").withExec(["npm", "install"]);

    // run application tests
    const test = runner.withExec(["npm", "test", "--", "--watchAll=false"]);

    // first stage
    // build application
    const buildDir = test
      .withExec(["npm", "run", "build"])
      .directory("./build");

    // second stage
    // use an nginx:alpine container
    // copy the build/ directory from the first stage
    // publish the resulting container to a registry
    // await publishNginxImage(client, buildDir);
  },
  { LogOutput: process.stdout }
);

function isImageNotFoundError(e: unknown) {
  return e instanceof GraphQLRequestError && e.message.includes("not found");
}

async function publishNginxImage(client, buildDir) {
  const imageRef = await client
    .container()
    .from("nginx:1.23-alpine")
    .withDirectory("/usr/share/nginx/html", buildDir)
    .publish("ttl.sh/hello-dagger-" + Math.floor(Math.random() * 10000000));
  console.log(`Published image to: ${imageRef}`);
}

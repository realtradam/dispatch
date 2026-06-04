# Rule: no internal mocks

A unit test that mocks one of OUR OWN modules (`@dispatch/*`) is a DESIGN BUG,
not a test to write. Move the decision logic to a pure function and inject the
effect, then test the pure function directly.
Mocking the OUTERMOST edge (real network, real clock) is the only allowed mock.
Kernel + pure-core packages must reach ZERO internal mocks.

# Adaptive front tracking for lubrication-type free boundary flows

## Abstract

We study a family of lubrication models in which a thin liquid layer spreads over a solid support and the wetted region itself is unknown. Because the wetted region is unknown, spreading becomes a free boundary problem: the curve where the layer thickness vanishes has to be tracked together with the layer profile. We propose a front tracking discretisation that keeps the moving curve on the mesh, so the degenerate mobility is never evaluated on a fixed grid that ignores the front. The scheme couples a mixed finite element formulation for the layer profile with an explicit update of the front position derived from mass balance. We prove that the discrete scheme conserves mass up to the quadrature error, and we report convergence rates in one and two dimensions for spreading drops, receding rims, and a pinch-off benchmark. The experiments show that tracking the front removes the spurious precursor layer that fixed grid methods introduce, and that the measured front speed agrees with the asymptotic prediction across three decades of viscosity contrast.

## 1 Introduction and model statement

Thin layers of viscous liquid appear in coating lines, in printing, and in the tear film of the eye, and in each of these settings the interesting physics happens where the layer ends. Classical lubrication theory reduces the flow to a single scalar equation for the layer thickness, but that reduction is only valid while the thickness stays positive. At the edge of the layer the thickness degenerates, the mobility vanishes, and the reduced equation changes type. Numerical schemes that ignore the degeneracy usually restore positivity by adding a thin artificial film everywhere on the substrate. That repair is convenient, yet it fixes the very quantity the experiments are meant to measure, because the speed of the edge depends on how the thickness approaches zero.

Our starting point is therefore a model stated on a moving domain rather than on a fixed box. The liquid occupies a region of the substrate that changes in time, the layer thickness is positive inside that region, and the thickness vanishes on its boundary. Conservation of mass inside the region yields a fourth order parabolic equation with a degenerate mobility, while conservation of mass across the boundary yields a condition on the speed of the boundary itself. Together they form a closed free boundary problem whose unknowns are the thickness and the region, and both unknowns must be discretised with comparable accuracy if the computed spreading law is to be trusted.

The contribution of this paper is a discretisation in which the mesh carries the free boundary as a set of element faces. We restate the model in a weak form that is posed on the moving domain, we derive a discrete kinematic condition from the same mass balance that produced the continuous one, and we advance the mesh with a velocity extension that is harmonic inside the wetted region. Section 2 develops the algorithm, including the weak formulation, the kinematic condition, and a summary of the resulting time step. Sections 3 and 4 report one and two dimensional experiments, and Section 5 collects what the experiments say about the accuracy of the front speed and about the cost of remeshing.

## 2 Numerical algorithm

The algorithm advances a triangulated wetted region and a finite element thickness defined on that triangulation. Each time step has three stages. The first stage solves a mixed problem for the thickness and an auxiliary pressure on the current mesh, holding the domain fixed. The second stage evaluates the discrete kinematic condition on the boundary faces and produces a nodal velocity for every boundary vertex. The third stage extends that boundary velocity into the interior, moves the vertices, and checks the resulting mesh quality against a fixed shape criterion, remeshing only where the criterion fails.

Splitting the step this way keeps every stage linear, which matters because the degenerate mobility makes a monolithic Newton iteration fragile near the front. It also isolates the geometric error: the thickness error comes from the mixed solve, while the geometric error comes from the vertex motion, and the two can be refined independently when we study convergence. We use a semi-implicit treatment in which the mobility is evaluated at the old time level and the fourth order operator is treated implicitly, which removes the usual time step restriction from the surface tension term without requiring a nonlinear solve.

## 2.1 Weak formulation

Let $\omega(t)$ denote the wetted region, let $h(\mathbf{x}, t)$ be the layer thickness, and let $\pi$ be the auxiliary pressure. The pair $(h, \pi)$ solves

$$\int_{\omega(t)} \partial_t h \, \varphi \, d\mathbf{x} + \int_{\omega(t)} m(h) \, \nabla \pi \cdot \nabla \varphi \, d\mathbf{x} = 0 \qquad \forall \varphi \in V(\omega(t)),$$

$$\int_{\omega(t)} \pi \, \psi \, d\mathbf{x} - \int_{\omega(t)} \nabla h \cdot \nabla \psi \, d\mathbf{x} = 0 \qquad \forall \psi \in V(\omega(t)),$$

with the degenerate mobility $m(h) = \frac{h^3}{3} + \beta h^2$ and the pressure identity $\pi = -\Delta h$. The discrete spaces are

$$V_j(\omega_j) = \{ \varphi \in C(\overline{\omega_j}) : \varphi|_{K} \in P_1(K) \ \forall K \in \mathcal{T}_j \}, \qquad \pi_j \in V_j(\omega_j), \qquad h_j \in V_j(\omega_j),$$

$$\int_{\omega_j} \frac{h_j - h_{j-1}}{\tau} \varphi \, d\mathbf{x} + \int_{\omega_j} m(h_{j-1}) \, \nabla \pi_j \cdot \nabla \varphi \, d\mathbf{x} = 0, \qquad \mathbf{q}_j = -m(h_{j-1}) \nabla \pi_j .$$

Taking $\varphi \equiv 1$ shows that $\int_{\omega_j} h_j \, d\mathbf{x} = \int_{\omega_j} h_{j-1} \, d\mathbf{x}$ up to quadrature.

## 2.2 Kinematic condition

The velocity of the free boundary follows from the kinematic relation between the film height and the normal speed. Writing $\mathbf{v}$ for the velocity of $\partial \omega(t)$ and $\mathbf{n}$ for its outward normal,

$$\mathbf{v} \cdot \mathbf{n} = - \lim_{\mathbf{x} \to \partial \omega(t)} \frac{m(h)}{h} \, \nabla \Delta h \cdot \mathbf{n}, \qquad h = 0 \ \text{ on } \ \partial \omega(t),$$

$$\partial_t h + \nabla \cdot \big( m(h) \, \nabla \Delta h \big) = 0 \quad \text{in } \omega(t), \qquad \frac{d}{dt} \int_{\omega(t)} h \, d\mathbf{x} = \int_{\partial \omega(t)} h \, \mathbf{v} \cdot \mathbf{n} \, ds = 0 .$$

$$\frac{m(h)}{h} = \frac{h^2}{3} + \beta h \xrightarrow[h \to 0]{} 0, \qquad \nabla \Delta h \sim \frac{\mathbf{c}}{\operatorname{dist}(\mathbf{x}, \partial \omega(t))} \quad \text{as } \mathbf{x} \to \partial \omega(t),$$

$$\mathbf{v}_j \cdot \mathbf{n} = - \frac{1}{|F|} \int_{F} \frac{m(h_{j-1})}{h_{j-1} + \varepsilon} \, \mathbf{q}_j \cdot \mathbf{n} \, ds \qquad \text{for every boundary face } F \subset \partial \omega_j .$$

The product of a vanishing factor and a singular factor stays finite, which is why the front speed is well defined.

## 2.3 Algorithm summarized

One time step of the method therefore reads as follows. Assemble the mixed system on the current triangulation with the mobility frozen at the previous level, solve it for the thickness and the pressure, and recover the discrete flux on every boundary face. Evaluate the averaged kinematic condition face by face, and project the face values onto the boundary vertices with an area weighted average, which avoids the checkerboard modes that a direct nodal evaluation produces on anisotropic meshes.

Extend the boundary velocity into the wetted region by solving a discrete harmonic problem with the boundary velocity as data, then move every vertex by one explicit Euler step of that extended field. Measure the minimum angle of the deformed triangulation, and rebuild the mesh locally when the minimum angle drops below the tolerance, transferring the thickness with a conservative projection. In practice a local rebuild is required on roughly one step in forty for the spreading drop, and on one step in twelve for the receding rim, where the front sweeps a longer distance per step.

## 3 Examples in 1D

The first experiment is a symmetric spreading drop on a flat substrate. We start from a parabolic cap of unit mass, integrate to the time at which the support has doubled, and compare the computed support with the similarity solution. The support error decreases at first order in the time step and at second order in the mesh size, which matches the accuracy of the explicit vertex motion combined with the piecewise linear thickness. Mass is conserved to eleven digits over the whole integration, and the discrete energy decreases monotonically.

The second experiment is a receding rim, which stresses the scheme in the opposite direction because the wetted region shrinks and the mesh near the front is compressed. Here the fixed grid reference computation with an artificial precursor layer reports a speed that is twelve per cent too large at the coarsest resolution, and the error does not disappear under refinement, because the precursor thickness sets a length scale of its own. The front tracking scheme has no such floor, and its speed error falls below half a per cent once the front region is resolved by eight elements.

## 4 Examples in 2D

In two dimensions we repeat the spreading drop on an unstructured triangulation and add a pinch-off benchmark in which a dumbbell shaped region separates into two drops. The spreading drop again converges at the rates observed in one dimension, and the computed contact line stays circular to within the mesh size, which shows that the velocity extension does not introduce a preferred direction on an unstructured mesh.

The pinch-off benchmark is harder because the topology of the wetted region changes. We detect the collision of two boundary segments with a distance criterion evaluated on the extended velocity field, split the region at the collision point, and continue with two independent triangulations. The mass of each resulting drop agrees with the prediction from the initial profile to within the quadrature error, and the time of separation converges at first order. We regard this as evidence that a tracked front can handle a topological change without falling back to a fixed grid formulation, provided the detection criterion uses the same velocity field that moves the mesh.

## 5 Conclusion

Tracking the free boundary on the mesh makes the spreading law a computable output rather than a consequence of a regularisation parameter. The three ingredients that make this work are a weak formulation posed on the moving region, a kinematic condition obtained from the same mass balance as the interior equation, and a velocity extension that keeps the interior mesh usable without smearing the boundary data. The cost of the method is dominated by the mixed solve, and local remeshing adds less than a tenth of the total run time in every experiment we report.

Two limitations remain. The explicit vertex motion restricts the step size when the front accelerates, and a semi-implicit treatment of the geometry would be a natural next step. The topological change in the pinch-off benchmark is handled by a criterion that we tuned by hand, and a criterion derived from the asymptotics of the thinning neck would be preferable. Neither limitation affects the accuracy of the spreading law reported above.

## References

[1] A. Brandt and L. Feo, Front tracking for degenerate parabolic equations, Journal of Synthetic Numerics, 12 (2019), pp. 45-78.

[2] C. Dupin, Mixed finite elements for fourth order problems on moving domains, Synthetic Mathematics of Computation, 71 (2017), pp. 1103-1131.

[3] E. Faragher and M. Oyelaran, A note on degenerate mobilities and precursor layers, Letters in Applied Analysis, 8 (2020), pp. 33-41.

[4] G. Halvorsen, Velocity extensions for moving mesh methods, Numerical Methods for Fluids, 45 (2018), pp. 221-249.

[5] K. Ibarra and N. Sandoval, Similarity solutions for spreading drops with partial wetting, Journal of Interface Theory, 5 (2021), pp. 9-27.

[6] P. Lindqvist, R. Aarons and T. Okonjo, Conservative projection between unstructured triangulations, Computational Geometry Reports, 33 (2016), pp. 512-540.

[7] S. Mbeki, Energy decay for semi-implicit schemes with frozen mobility, Analysis of Discrete Systems, 19 (2022), pp. 77-104.

[8] V. Nowak and D. Rasmussen, Topological changes in tracked interfaces, Interfaces and Meshes, 27 (2023), pp. 155-182.
